import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Agent,
  AgentCoreFile,
  AgentCoreFilesResponse,
  AgentToolName,
  AgentToolPreset,
  ReasoningLevel,
} from "../api/agents";
import type { ToolCatalogGroup } from "../api/tools";
import { toolPolicyFromPreset, toolPolicyFromSelection } from "../api/tools";
import { ToolGroupSelector } from "./ToolGroupSelector";
import { AgentAvatar, Badge, Field } from "./components";

type AgentsTab = "overview" | "persona" | "tools" | "core";

export interface AgentConfigPatch {
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
  skills?: string[] | null;
  instructions: string;
}

interface Draft {
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
  skillsText: string;
  instructions: string;
}

export interface AgentEditModalProps {
  open: boolean;
  /**
   * The agent currently being edited. Only consulted when `open === true`.
   * Mutating the agent or swapping it (e.g. an undo-toast restore) reloads
   * the draft; if it disappears the modal closes itself.
   */
  agent: Agent | null;
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
 * the Accio "edit-in-modal" pattern. Houses the same tabbed surface
 * (概览 / Persona / 工具 / Agent Core) that previously lived inline on
 * AgentsPage; the move to a modal lets the browse grid stay focused on
 * discovery while keeping the editor a single Esc keypress away.
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
  // Tracks whether the modal is currently mounted + open. We branch on this
  // before any state setter that follows an awaited Promise, so a save that
  // resolves after the user dismissed the modal doesn't poke a dead tree.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  // When the modal closes mid-flight, reset the flash + file status so the
  // next open doesn't inherit stale UI from a previous session. Also clears
  // `fileBusy` because the file-load effects branch on `!open` and skip
  // their own cleanup, otherwise a closed-mid-load modal would reopen with
  // a stuck "处理中..." button.
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

  // Reset the draft + scratch state every time the modal opens for a new
  // agent. This avoids leaking edits between agents and ensures the close
  // button always sees a clean slate next time around.
  useEffect(() => {
    if (!open || !agent) return;
    setDraft(draftFromAgent(agent));
    setTab("overview");
    setSavedFlash(false);
    setFileStatus("");
  }, [open, agent?.id]);

  // Compare draft to the upstream agent to detect unsaved changes.
  const isDirty = useMemo(() => {
    if (!agent) return false;
    const reference = draftFromAgent(agent);
    return (
      draft.name !== reference.name ||
      draft.description !== reference.description ||
      draft.model !== reference.model ||
      draft.reasoning !== reference.reasoning ||
      draft.toolPreset !== reference.toolPreset ||
      draft.skillsText !== reference.skillsText ||
      draft.instructions !== reference.instructions ||
      !sameStringSet(draft.tools, reference.tools) ||
      !sameStringSet(draft.toolInclude, reference.toolInclude) ||
      !sameStringSet(draft.toolExclude, reference.toolExclude)
    );
  }, [draft, agent]);

  // Cleanup the saved-flash timer on unmount.
  useEffect(() => {
    return () => {
      if (savedFlashTimer.current !== null) clearTimeout(savedFlashTimer.current);
    };
  }, []);

  // Load core files for the editing agent. Re-runs when the modal opens or
  // the active agent changes.
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

  // Esc closes the modal, matching the rest of the app's modal contract.
  // We don't gate on isDirty here — the overlay click stays available for
  // a confirm-style "are you sure?" UX if we ever need it.
  //
  // The handler reads `saving` and `onClose` through a ref so the listener
  // is bound once per open/close cycle rather than on every parent re-render
  // (where `onClose` is typically a fresh inline arrow). The ref is written
  // in a layout effect (commit phase) rather than during render to stay
  // safe under React 18 StrictMode double-render and concurrent rendering.
  const escDepsRef = useRef({ saving, onClose: props.onClose });
  useEffect(() => {
    escDepsRef.current = { saving, onClose: props.onClose };
  });
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const { saving: isSaving, onClose } = escDepsRef.current;
      if (!isSaving) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
      onClick={() => {
        if (!saving) props.onClose();
      }}
    >
      <div
        className="modal-card agent-edit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
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
              onClick={() => props.onOpenChat(agent.id)}
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
              onClick={() => {
                if (!saving) props.onClose();
              }}
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
            <div className="agent-config-panel" role="tabpanel">
              <div className="agent-config-grid">
                <Field label="名称">
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </Field>
                <Field label="模型">
                  <input
                    value={draft.model}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  />
                </Field>
                <Field label="推理强度">
                  <select
                    value={draft.reasoning}
                    onChange={(e) =>
                      setDraft({ ...draft, reasoning: e.target.value as ReasoningLevel })
                    }
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </Field>
                <Field label="Skills" hint="留空=全部可用，逗号分隔；输入 none 禁用">
                  <input
                    aria-label="Skills"
                    value={draft.skillsText}
                    onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="描述">
                <textarea
                  rows={3}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </Field>
              <InfoBlock title="Workspace" value={agent.workspace.path} />
            </div>
          ) : null}

          {tab === "persona" ? (
            <div className="agent-config-panel" role="tabpanel">
              <Field
                label="Instructions"
                hint="定义这个智能体的行为边界、工作方式和输出风格。"
              >
                <textarea
                  rows={14}
                  value={draft.instructions}
                  onChange={(e) =>
                    setDraft({ ...draft, instructions: e.target.value })
                  }
                />
              </Field>
            </div>
          ) : null}

          {tab === "tools" ? (
            <div className="agent-config-panel" role="tabpanel">
              <section className="agent-tools">
                <div className="agent-tools-head">
                  <Field label="Tools 预设">
                    <select
                      value={draft.toolPreset}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          ...toolPolicyFromPreset(event.target.value as AgentToolPreset),
                        })
                      }
                    >
                      <option value="minimal">minimal</option>
                      <option value="standard">standard</option>
                      <option value="developer">developer</option>
                      <option value="tl">tl</option>
                      <option value="full">full</option>
                      <option value="none">none</option>
                    </select>
                  </Field>
                  <div className="agent-tools-presets">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() =>
                        setDraft({ ...draft, ...toolPolicyFromPreset("full") })
                      }
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() =>
                        setDraft({ ...draft, ...toolPolicyFromPreset("none") })
                      }
                    >
                      清空
                    </button>
                  </div>
                </div>
                <ToolGroupSelector
                  groups={props.toolGroups}
                  selected={draft.tools}
                  onChange={(tools) =>
                    setDraft({
                      ...draft,
                      ...toolPolicyFromSelection(draft.toolPreset, tools),
                    })
                  }
                />
              </section>
            </div>
          ) : null}

          {tab === "core" ? (
            <div className="agent-config-panel" role="tabpanel">
              <section className="agent-core">
                <div className="agent-core-head">
                  <div>
                    <h3 className="agent-core-title">Agent Core</h3>
                    <div className="agent-core-path">{corePath || "未加载"}</div>
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!selectedFile || fileBusy}
                    onClick={saveCoreFile}
                  >
                    {fileBusy ? "处理中..." : "保存文件"}
                  </button>
                </div>

                <div className="agent-core-body">
                  <div className="agent-core-files">
                    {coreFiles.map((file) => (
                      <button
                        key={file.name}
                        type="button"
                        className="agent-core-file"
                        data-active={file.name === selectedFile ? "true" : undefined}
                        onClick={() => setSelectedFile(file.name)}
                        aria-pressed={file.name === selectedFile}
                      >
                        {file.name}
                      </button>
                    ))}
                  </div>
                  <textarea
                    aria-label="Agent Core 文件内容"
                    className="agent-core-editor"
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                    rows={14}
                    disabled={!selectedFile || fileBusy}
                  />
                </div>
                {fileStatus ? (
                  <div className="agent-core-status">{fileStatus}</div>
                ) : null}
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SaveStatusIndicator({
  saving,
  isDirty,
  savedFlash,
}: {
  saving: boolean;
  isDirty: boolean;
  savedFlash: boolean;
}): ReactNode {
  if (saving) return <Badge tone="info">保存中…</Badge>;
  if (savedFlash) return <Badge tone="success">已保存</Badge>;
  if (isDirty) return <Badge tone="warning">未保存</Badge>;
  return null;
}

function InfoBlock(props: { title: string; value: string }) {
  return (
    <div className="agent-info-block">
      <div className="agent-info-label">{props.title}</div>
      <div className="agent-info-value">{props.value}</div>
    </div>
  );
}

function draftFromAgent(agent: Agent | null): Draft {
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    model: agent?.model ?? "",
    reasoning: agent?.reasoning ?? "medium",
    tools: agent?.tools ? [...agent.tools] : [],
    toolPreset: agent?.toolPreset ?? "none",
    toolInclude: agent?.toolInclude ?? agent?.tools ?? [],
    toolExclude: agent?.toolExclude ?? [],
    skillsText:
      agent?.skills === undefined
        ? ""
        : agent.skills.length === 0
        ? "none"
        : agent.skills.join(", "),
    instructions: agent?.instructions ?? "",
  };
}

function parseSkills(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameStringSet(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const v of b) {
    if (!set.has(v)) return false;
  }
  return true;
}
