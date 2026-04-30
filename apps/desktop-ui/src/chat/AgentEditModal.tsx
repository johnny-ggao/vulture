import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  AgentCoreFile,
  AgentCoreFilesResponse,
} from "../api/agents";
import type { ToolCatalogGroup } from "../api/tools";
import {
  AgentAvatar,
  useCursorGloss,
} from "./components";
import {
  CoreTab,
  OverviewTab,
  PersonaTab,
  SaveStatusIndicator,
  ToolsTab,
  draftFromAgent,
  isDirtyDraft,
  parseSkills,
  type AgentConfigPatch,
  type Draft,
} from "./editAgentTabs";

export type { AgentConfigPatch };

type AgentsTab = "overview" | "persona" | "tools" | "core";

export interface AgentEditModalProps {
  open: boolean;
  /**
   * The agent currently being edited. Only consulted when `open === true`.
   * Mutating the agent or swapping it (e.g. an undo-toast restore) reloads
   * the draft; if it disappears the modal closes itself.
   */
  agent: Agent | null;
  agents: ReadonlyArray<Agent>;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  onClose: () => void;
  onOpenChat: (id: string) => void;
  onSave: (id: string, patch: AgentConfigPatch) => Promise<void>;
  onListFiles: (id: string) => Promise<AgentCoreFilesResponse>;
  onLoadFile: (id: string, name: string) => Promise<string>;
  onSaveFile: (id: string, name: string, content: string) => Promise<void>;
}

/**
 * Drill-in editor for a single agent, presented as a modal overlay matching
 * the Accio "edit-in-modal" pattern. Owns draft + saving + file state; each
 * tab (Overview / Persona / Tools / Core) lives in its own controlled
 * component under `./editAgentTabs/`.
 */
export function AgentEditModal(props: AgentEditModalProps) {
  const { open, agent } = props;

  const [draft, setDraft] = useState<Draft>(() => draftFromAgent(agent));
  const [saving, setSaving] = useState(false);
  const [coreFiles, setCoreFiles] = useState<AgentCoreFile[]>([]);
  const [corePath, setCorePath] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileStatus, setFileStatus] = useState("");
  const [fileBusy, setFileBusy] = useState(false);
  const [tab, setTab] = useState<AgentsTab>("overview");
  const [savedFlash, setSavedFlash] = useState(false);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tracks whether the modal is currently mounted + open. Branch on this
  // before any state setter that follows an awaited Promise so a save that
  // resolves after the user dismissed the modal doesn't poke a dead tree.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Reset the draft + scratch state every time the modal opens for a new
  // agent so edits never leak between sessions.
  useEffect(() => {
    if (!open || !agent) return;
    setDraft(draftFromAgent(agent));
    setTab("overview");
    setSavedFlash(false);
    setFileStatus("");
  }, [open, agent?.id]);

  // When the modal closes mid-flight, clear flash + file status + busy so
  // the next open doesn't inherit stale UI.
  useEffect(() => {
    if (open) return;
    if (savedFlashTimer.current !== null) {
      clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = null;
    }
    setSavedFlash(false);
    setFileStatus("");
    setFileBusy(false);
  }, [open]);

  const isDirty = useMemo(() => isDirtyDraft(draft, agent), [draft, agent]);

  // Cleanup the saved-flash timer on unmount.
  useEffect(() => {
    return () => {
      if (savedFlashTimer.current !== null) clearTimeout(savedFlashTimer.current);
    };
  }, []);

  // Load core files for the editing agent.
  useEffect(() => {
    let cancelled = false;
    setCoreFiles([]);
    setCorePath("");
    setSelectedFile("");
    setFileContent("");
    if (!open || !agent) return;
    (async () => {
      try {
        const result = await props.onListFiles(agent.id);
        if (cancelled) return;
        setCoreFiles(result.files);
        setCorePath(result.corePath);
        setSelectedFile(
          result.files.find((file) => file.name === "AGENTS.md")?.name ??
            result.files[0]?.name ??
            "",
        );
      } catch (cause) {
        if (!cancelled) setFileStatus(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, agent?.id]);

  // Load the contents of the selected core file when it changes.
  useEffect(() => {
    let cancelled = false;
    setFileContent("");
    if (!open || !agent || !selectedFile) return;
    setFileBusy(true);
    setFileStatus("");
    (async () => {
      try {
        const content = await props.onLoadFile(agent.id, selectedFile);
        if (!cancelled) setFileContent(content);
      } catch (cause) {
        if (!cancelled) setFileStatus(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setFileBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, agent?.id, selectedFile]);

  // Esc closes (with dirty-confirm), Cmd/Ctrl+S saves. Both handlers read
  // their dependencies through a ref so the listener is bound once per
  // open/close cycle. The ref is committed in an effect (commit phase)
  // rather than during render to stay safe under React 18 StrictMode and
  // concurrent rendering.
  const keyDepsRef = useRef({
    saving,
    isDirty,
    canSave: false,
    onClose: props.onClose,
    save: async () => {},
  });
  useEffect(() => {
    keyDepsRef.current = {
      saving,
      isDirty,
      canSave:
        !saving &&
        isDirty &&
        draft.name.trim().length > 0 &&
        draft.instructions.trim().length > 0,
      onClose: props.onClose,
      save,
    };
  });
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      const deps = keyDepsRef.current;
      // Cmd+S / Ctrl+S saves the draft. Always intercept (even when
      // there's nothing to save) so the OS save dialog never opens —
      // the modal owns this shortcut while it's mounted.
      if (
        event.key === "s" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        if (deps.canSave) void deps.save();
        return;
      }
      // Esc closes — but if the draft is dirty we ask first so users
      // don't lose work to a stray keypress. Saving in flight, the key
      // is ignored until the save resolves.
      if (event.key === "Escape") {
        if (deps.saving) return;
        if (deps.isDirty) {
          if (window.confirm("有未保存的修改，确定要关闭吗？")) {
            deps.onClose();
          }
          return;
        }
        deps.onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /**
   * Close-with-confirm wrapper: any close path (overlay click, X
   * button) that comes through here gets the dirty guard. Esc handler
   * mirrors this in the keydown listener above.
   */
  function requestClose() {
    if (saving) return;
    if (isDirty) {
      if (!window.confirm("有未保存的修改，确定要关闭吗？")) return;
    }
    props.onClose();
  }

  /**
   * Same dirty-guard for the inline "打开对话" handoff. Switching the
   * surface away from the modal effectively closes it; reusing the
   * same prompt keeps the UX consistent so users learn one rule.
   */
  function requestOpenChat() {
    if (saving || !agent) return;
    if (isDirty) {
      if (
        !window.confirm("有未保存的修改，确定要离开并打开对话吗？")
      ) {
        return;
      }
    }
    props.onOpenChat(agent.id);
  }

  // Cursor-tracked gloss on the modal header — same idiom as AgentCard.
  const { ref: headerRef, ...headerGloss } = useCursorGloss<HTMLDivElement>();

  async function save() {
    if (!agent || !draft.name.trim() || !draft.instructions.trim() || saving) return;
    setSaving(true);
    try {
      await props.onSave(agent.id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        model: draft.model.trim(),
        reasoning: draft.reasoning,
        tools: draft.tools,
        toolPreset: draft.toolPreset,
        toolInclude: draft.toolInclude,
        toolExclude: draft.toolExclude,
        handoffAgentIds: draft.handoffAgentIds,
        skills: parseSkills(draft.skillsText),
        instructions: draft.instructions.trim(),
      });
      if (!aliveRef.current) return;
      if (savedFlashTimer.current !== null) clearTimeout(savedFlashTimer.current);
      setSavedFlash(true);
      savedFlashTimer.current = setTimeout(() => {
        if (aliveRef.current) setSavedFlash(false);
      }, 1800);
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  }

  async function saveCoreFile() {
    if (!agent || !selectedFile || fileBusy) return;
    setFileBusy(true);
    setFileStatus("");
    try {
      await props.onSaveFile(agent.id, selectedFile, fileContent);
      const result = await props.onListFiles(agent.id);
      if (!aliveRef.current) return;
      setCoreFiles(result.files);
      setCorePath(result.corePath);
      setFileStatus("已保存");
    } catch (cause) {
      if (!aliveRef.current) return;
      setFileStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (aliveRef.current) setFileBusy(false);
    }
  }

  if (!open || !agent) return null;

  return (
    <div
      className="modal-overlay"
      onClick={requestClose}
    >
      <div
        className="modal-card agent-edit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="modal-header"
          ref={headerRef}
          {...headerGloss}
        >
          <div className="agent-config-title-block">
            <AgentAvatar agent={agent} size={40} shape="square" />
            <div>
              <span className="modal-title">{agent.name || "未命名智能体"}</span>
              <div className="agent-config-id">{agent.id}</div>
            </div>
          </div>
          <div className="agent-edit-modal-actions">
            <SaveStatusIndicator
              saving={saving}
              isDirty={isDirty}
              savedFlash={savedFlash}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={requestOpenChat}
            >
              打开对话
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={saving || !isDirty || !draft.name.trim() || !draft.instructions.trim()}
              onClick={save}
            >
              {saving ? "保存中..." : "保存"}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="关闭"
              disabled={saving}
              onClick={requestClose}
            >
              <svg
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 4l8 8M4 12l8-8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="modal-body agent-edit-modal-body">
          <div
            className="agent-config-tabs"
            role="tablist"
            aria-label="智能体配置"
          >
            {(
              [
                { key: "overview" as const, label: "概览" },
                { key: "persona" as const, label: "Persona" },
                { key: "tools" as const, label: "工具" },
                { key: "core" as const, label: "Agent Core" },
              ]
            ).map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={tab === entry.key}
                tabIndex={tab === entry.key ? 0 : -1}
                className={"agent-config-tab" + (tab === entry.key ? " active" : "")}
                onClick={() => setTab(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {tab === "overview" ? (
            <OverviewTab agent={agent} draft={draft} onChange={setDraft} />
          ) : null}
          {tab === "persona" ? (
            <PersonaTab draft={draft} onChange={setDraft} />
          ) : null}
          {tab === "tools" ? (
            <ToolsTab
              draft={draft}
              agentId={agent.id}
              agents={props.agents}
              toolGroups={props.toolGroups}
              onChange={setDraft}
            />
          ) : null}
          {tab === "core" ? (
            <CoreTab
              files={coreFiles}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              fileContent={fileContent}
              onChangeFileContent={setFileContent}
              fileBusy={fileBusy}
              fileStatus={fileStatus}
              corePath={corePath}
              onSave={saveCoreFile}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
