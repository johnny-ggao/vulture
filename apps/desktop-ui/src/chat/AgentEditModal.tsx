import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import type {
  Agent,
  AgentCoreFile,
  AgentCoreFilesResponse,
} from "../api/agents";
import type { ToolCatalogGroup } from "../api/tools";
import { AgentAvatar, hashHue } from "./components";
import {
  CoreTab,
  HandoffTab,
  OverviewTab,
  PersonaTab,
  SaveStatusIndicator,
  ToolsTab,
  dirtyTabs,
  draftFromAgent,
  isDirtyDraft,
  parseSkills,
  type AgentConfigPatch,
  type Draft,
  type DraftTabKey,
} from "./editAgentTabs";

export type { AgentConfigPatch };

type AgentsTab = "overview" | "persona" | "tools" | "handoff" | "core";

const TAB_ORDER: ReadonlyArray<AgentsTab> = [
  "overview",
  "persona",
  "tools",
  "handoff",
  "core",
];

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Capture the element that had focus the moment the modal opens so we
  // can return focus there on close — the WAI-ARIA "modal dialog"
  // pattern. Without this, keyboard users find themselves dumped at
  // document.body when the modal goes away.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Round 17: track the last tab-switch source. When the user arrows
  // between tabs we want focus to follow (otherwise the keyboard
  // pattern strands focus on the previously-active button). Mouse
  // clicks set 'mouse' so we don't steal focus mid-form.
  const tabSwitchSourceRef = useRef<"keyboard" | "mouse" | null>(null);
  // Refs per tab button so the keyboard handler can re-focus the
  // newly-active tab AFTER React commits its tabIndex flip.
  const tabRefs = useRef<Record<AgentsTab, HTMLButtonElement | null>>({
    overview: null,
    persona: null,
    tools: null,
    handoff: null,
    core: null,
  });

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
    setSaveError(null);
    setFileStatus("");
  }, [open, agent?.id]);

  // Round 15 — focus management. When the modal opens, snapshot the
  // currently-focused element so we can return focus to it on close
  // (WAI-ARIA modal-dialog pattern). The save button gets focus on
  // open as the most likely next action; if it ends up disabled (no
  // changes yet), the close button is the runner-up.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      const node = restoreFocusRef.current;
      restoreFocusRef.current = null;
      // Defer one tick so React commits the unmount before we steal
      // focus — otherwise focus lands inside the just-unmounted tree.
      queueMicrotask(() => node?.focus({ preventScroll: true }));
    };
  }, [open]);

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
  const dirtyTabSet = useMemo(() => dirtyTabs(draft, agent), [draft, agent]);

  // Round 17 — when the user arrows between tabs, follow focus so
  // the next ArrowLeft/Right keystroke goes to the right element.
  // We only do this when tabSwitchSourceRef.current === "keyboard"
  // so mouse clicks (or programmatic resets when the modal opens)
  // don't steal focus from form inputs.
  useEffect(() => {
    if (tabSwitchSourceRef.current !== "keyboard") return;
    tabSwitchSourceRef.current = null;
    const node = tabRefs.current[tab];
    node?.focus({ preventScroll: true });
  }, [tab]);

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

  async function save() {
    if (!agent || !draft.name.trim() || !draft.instructions.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
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
    } catch (cause) {
      // Round 15: surface the error inline next to the save button.
      // The previous behaviour silently swallowed exceptions which
      // left the user staring at a still-dirty form with no feedback.
      if (!aliveRef.current) return;
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : "保存失败，请重试。";
      setSaveError(message);
      // Re-throw so callers / the runtime can log; aliveRef-guarded
      // setState above already moved the visible state.
      console.error("Agent save failed", cause);
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
        {/* Top action bar — quiet chrome row above the identity hero,
          * holds the save status indicator on the left and the action
          * rail (revert / chat / save / close) on the right. Keeps
          * primary actions accessible without putting button chrome on
          * top of the colored banner where contrast would suffer. */}
        <div className="agent-edit-topbar">
          <SaveStatusIndicator
            saving={saving}
            isDirty={isDirty}
            savedFlash={savedFlash}
          />
          <div className="agent-edit-topbar-actions">
            {isDirty && !saving ? (
              <button
                type="button"
                className="btn-secondary agent-edit-revert"
                onClick={() => {
                  if (!agent) return;
                  if (window.confirm("放弃当前修改？此操作无法撤销。")) {
                    setDraft(draftFromAgent(agent));
                    setSaveError(null);
                  }
                }}
                title="撤销所有未保存的修改"
              >
                撤销修改
              </button>
            ) : null}
            <button
              type="button"
              className="btn-secondary"
              onClick={requestOpenChat}
            >
              打开对话
            </button>
            <button
              type="button"
              className="btn-primary agent-edit-save"
              disabled={saving || !isDirty || !draft.name.trim() || !draft.instructions.trim()}
              onClick={save}
            >
              {saving ? (
                <>
                  <span className="agent-edit-save-spinner" aria-hidden="true" />
                  保存中…
                </>
              ) : (
                <>
                  保存
                  <kbd
                    className="agent-edit-save-kbd"
                    aria-hidden="true"
                  >
                    ⌘S
                  </kbd>
                </>
              )}
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

        {/* Identity hero — banner with per-agent hue + floating avatar
          * punching through the banner edge + centred name and id
          * chip. Mirrors the AgentCard product-tile pattern so the
          * editor visually picks up where the card left off. */}
        <div
          className="agent-edit-hero"
          style={
            {
              "--banner-hue": hashHue(agent.id).toString(),
            } as React.CSSProperties
          }
        >
          <div className="agent-edit-hero-banner" aria-hidden="true" />
          <div className="agent-edit-hero-avatar">
            <AgentAvatar agent={agent} size={56} shape="square" />
          </div>
          <h2 className="agent-edit-hero-name">{agent.name || "未命名智能体"}</h2>
          <div className="agent-edit-hero-id">
            <AgentIdChip id={agent.id} />
          </div>
        </div>

        <div className="modal-body agent-edit-modal-body">
          {/* Tabs visually adopt the Segmented pill look (round 14)
            * for cross-surface consistency with AgentsPage sort and
            * the tool preset, but keep role="tab" / aria-selected so
            * screen readers still announce them as tabs and the
            * tablist arrow-key navigation pattern stays correct.
            *
            * Round 17: full WAI-ARIA tablist keyboard pattern wired
            * up — Left/Right move between tabs (with wrap), Home/End
            * jump to the first/last tab. Activates as you arrow,
            * matching the "automatic activation" pattern most modal
            * editors use; the tab body re-renders on every change so
            * there's no surprise lazy-load behind the tab. */}
          <div
            className="agent-config-tabs segmented segmented-cozy"
            role="tablist"
            aria-label="智能体配置"
            onKeyDown={(event) => {
              const idx = TAB_ORDER.indexOf(tab);
              if (idx < 0) return;
              let next: AgentsTab | null = null;
              if (event.key === "ArrowRight") {
                next = TAB_ORDER[(idx + 1) % TAB_ORDER.length];
              } else if (event.key === "ArrowLeft") {
                next =
                  TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length];
              } else if (event.key === "Home") {
                next = TAB_ORDER[0];
              } else if (event.key === "End") {
                next = TAB_ORDER[TAB_ORDER.length - 1];
              }
              if (next === null) return;
              event.preventDefault();
              tabSwitchSourceRef.current = "keyboard";
              setTab(next);
            }}
          >
            {(
              [
                { key: "overview" as const, label: "基本信息", dirtyKey: "overview" as DraftTabKey },
                { key: "persona" as const, label: "人格", dirtyKey: "persona" as DraftTabKey },
                { key: "tools" as const, label: "技能", dirtyKey: "tools" as DraftTabKey },
                { key: "handoff" as const, label: "协作", dirtyKey: "handoff" as DraftTabKey },
                { key: "core" as const, label: "核心文件", dirtyKey: null },
              ]
            ).map((entry) => {
              const isDirtyTab =
                entry.dirtyKey !== null && dirtyTabSet.has(entry.dirtyKey);
              return (
                <button
                  key={entry.key}
                  ref={(node) => {
                    tabRefs.current[entry.key] = node;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.key}
                  tabIndex={tab === entry.key ? 0 : -1}
                  className={
                    "agent-config-tab segmented-segment" +
                    (tab === entry.key ? " active" : "") +
                    (isDirtyTab ? " has-changes" : "")
                  }
                  onClick={() => {
                    tabSwitchSourceRef.current = "mouse";
                    setTab(entry.key);
                  }}
                >
                  {entry.label}
                  {isDirtyTab ? (
                    // aria-hidden so the dot doesn't pollute the
                    // tab's accessible name. SR users have the
                    // SaveStatusIndicator pill in the modal header
                    // for the form-level dirty signal; this is a
                    // visual-only "you edited this tab" cue.
                    <span
                      className="agent-config-tab-dot"
                      aria-hidden="true"
                      title="有未保存的修改"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          {saveError ? (
            <div
              className="agent-edit-error"
              role="alert"
              aria-live="assertive"
            >
              <span className="agent-edit-error-icon" aria-hidden="true">
                <ErrorIcon />
              </span>
              <span className="agent-edit-error-message">{saveError}</span>
              <button
                type="button"
                className="agent-edit-error-retry"
                disabled={saving}
                onClick={save}
              >
                重试
              </button>
              <button
                type="button"
                className="agent-edit-error-dismiss"
                aria-label="关闭"
                onClick={() => setSaveError(null)}
              >
                <CloseSmallIcon />
              </button>
            </div>
          ) : null}

          {tab === "overview" ? (
            <OverviewTab agent={agent} draft={draft} onChange={setDraft} />
          ) : null}
          {tab === "persona" ? (
            <PersonaTab draft={draft} onChange={setDraft} />
          ) : null}
          {tab === "tools" ? (
            <ToolsTab
              draft={draft}
              toolGroups={props.toolGroups}
              onChange={setDraft}
            />
          ) : null}
          {tab === "handoff" ? (
            <HandoffTab
              draft={draft}
              agentId={agent.id}
              agents={props.agents}
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

/**
 * Copy-on-click chip showing the agent id in monospaced text. Reads
 * as a stable identifier rather than a body-text run, and gives the
 * user a low-friction way to grab the id for support / API debugging.
 */
function AgentIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — silently fall back; the chip just
      // doesn't flash 已复制.
    }
  }
  return (
    <button
      type="button"
      className="agent-id-chip"
      data-copied={copied || undefined}
      onClick={copy}
      aria-label={`复制 agent id ${id}`}
      title="复制 agent id"
    >
      <code>{id}</code>
      <span className="agent-id-chip-icon" aria-hidden="true">
        {copied ? <CheckSmallIcon /> : <CopyIcon />}
      </span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="8" height="9" rx="1.5" />
      <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" />
    </svg>
  );
}

function CheckSmallIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" />
    </svg>
  );
}

function CloseSmallIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M4 12l8-8" />
    </svg>
  );
}
