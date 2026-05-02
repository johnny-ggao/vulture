import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  AgentCoreFile,
  AgentCoreFilesResponse,
} from "../api/agents";
import type { ToolCatalogGroup } from "../api/tools";
import type { AuthStatusView } from "../commandCenterTypes";
import { AgentAvatar } from "./components";
import {
  CoreTab,
  HandoffTab,
  OverviewTab,
  SaveStatusIndicator,
  SkillsTab,
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

type AgentsTab = "overview" | "tools" | "skills" | "handoff" | "core";

const EDIT_TAB_ORDER: ReadonlyArray<AgentsTab> = [
  "overview",
  "tools",
  "skills",
  "handoff",
  "core",
];

/** Create mode hides the Core tab — files don't exist until the agent is created. */
const CREATE_TAB_ORDER: ReadonlyArray<AgentsTab> = [
  "overview",
  "tools",
  "skills",
  "handoff",
];

export interface AgentEditModalProps {
  open: boolean;
  /**
   * The agent being edited. `null` switches the modal into create mode:
   * the form starts blank, the save button calls `onCreate`, and
   * surfaces that don't make sense pre-creation (id chip, 撤销修改,
   * Core files tab) hide themselves.
   */
  agent: Agent | null;
  agents: ReadonlyArray<Agent>;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  /**
   * Auth state for the model picker. When omitted (test fixtures, etc.)
   * the picker falls back to "no provider configured" and only the
   * existing agent's saved model is shown so it doesn't disappear.
   */
  authStatus?: AuthStatusView | null;
  onClose: () => void;
  /** Required in edit mode; ignored in create mode. */
  onSave?: (id: string, patch: AgentConfigPatch) => Promise<void>;
  /** Required in create mode; ignored in edit mode. */
  onCreate?: (patch: AgentConfigPatch) => Promise<void>;
  /** Edit-only: list / load / save AGENTS.md + memories.md files. */
  onListFiles?: (id: string) => Promise<AgentCoreFilesResponse>;
  onLoadFile?: (id: string, name: string) => Promise<string>;
  onSaveFile?: (id: string, name: string, content: string) => Promise<void>;
}

/**
 * Drill-in editor for a single agent, presented as a modal overlay matching
 * the Accio "edit-in-modal" pattern. Owns draft + saving + file state; each
 * tab (Overview / Persona / Tools / Core) lives in its own controlled
 * component under `./editAgentTabs/`.
 */
export function AgentEditModal(props: AgentEditModalProps) {
  const { open, agent } = props;
  // create vs edit mode is fully derived from the agent prop. No
  // separate flag — keeps the source of truth simple.
  const isCreate = agent === null;

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
    tools: null,
    skills: null,
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

  // Reset the draft + scratch state every time the modal opens (for a
  // different agent or for the create flow). Edits never leak between
  // sessions.
  useEffect(() => {
    if (!open) return;
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

  // Load core files for the editing agent. Skipped in create mode
  // (Core tab isn't rendered) or when the parent didn't wire the
  // file handlers.
  useEffect(() => {
    let cancelled = false;
    setCoreFiles([]);
    setCorePath("");
    setSelectedFile("");
    setFileContent("");
    if (!open || !agent || !props.onListFiles) return;
    (async () => {
      try {
        const result = await props.onListFiles!(agent.id);
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
    if (!open || !agent || !selectedFile || !props.onLoadFile) return;
    setFileBusy(true);
    setFileStatus("");
    (async () => {
      try {
        const content = await props.onLoadFile!(agent.id, selectedFile);
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

  async function save() {
    if (!draft.name.trim() || !draft.instructions.trim() || saving) return;
    setSaving(true);
    setSaveError(null);
    const patch: AgentConfigPatch = {
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
      avatar: draft.avatar.trim() || undefined,
    };
    try {
      if (isCreate) {
        if (!props.onCreate) {
          throw new Error("create mode requires an onCreate handler");
        }
        await props.onCreate(patch);
      } else {
        if (!agent || !props.onSave) return;
        await props.onSave(agent.id, patch);
      }
      if (!aliveRef.current) return;
      if (savedFlashTimer.current !== null) clearTimeout(savedFlashTimer.current);
      setSavedFlash(true);
      savedFlashTimer.current = setTimeout(() => {
        if (aliveRef.current) setSavedFlash(false);
      }, 1800);
    } catch (cause) {
      if (!aliveRef.current) return;
      const fallback = isCreate ? "创建失败，请重试。" : "保存失败，请重试。";
      const message =
        cause instanceof Error && cause.message ? cause.message : fallback;
      setSaveError(message);
      console.error(isCreate ? "Agent create failed" : "Agent save failed", cause);
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  }

  async function saveCoreFile() {
    if (!agent || !selectedFile || fileBusy) return;
    if (!props.onSaveFile || !props.onListFiles) return;
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

  // Open gates: edit mode requires an agent; create mode requires
  // `onCreate`. Both modes need `open: true`.
  if (!open) return null;
  if (!isCreate && !agent) return null;

  return (
    <div
      className="modal-overlay"
      onClick={requestClose}
    >
      <div
        className="modal-card agent-edit-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Round 22 — Accio-style modal layout.
          * Header: small avatar + agent name + id (left) + close (right).
          * Body grid: vertical tab rail (left) + form content (right).
          * Footer: save-status + revert/chat (left) + primary save (right).
          */}
        <div className="agent-edit-header">
          <div className="agent-edit-header-meta">
            <AgentAvatar
              agent={
                agent ?? {
                  id: draft.name.trim() || "new-agent",
                  name: draft.name.trim() || "新建智能体",
                }
              }
              size={36}
              shape="square"
            />
            <div className="agent-edit-header-text">
              <h2 className="agent-edit-header-name">
                {isCreate
                  ? draft.name.trim() || "新建智能体"
                  : agent?.name || "未命名智能体"}
              </h2>
              {!isCreate && agent ? (
                <div className="agent-edit-header-id">
                  <AgentIdChip id={agent.id} />
                </div>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="icon-btn agent-edit-header-close"
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

        <div
          className="agent-edit-body"
          data-has-preview={tab === "overview" ? "true" : undefined}
        >
          {/* Vertical tab rail — Accio idiom. Up/Down arrow keys
            * navigate, Home/End jump to first/last. Same WAI-ARIA
            * tablist contract as the previous horizontal segmented
            * version, just rotated 90°. */}
          <div
            className="agent-edit-rail"
            role="tablist"
            aria-orientation="vertical"
            aria-label="智能体配置"
            onKeyDown={(event) => {
              const tabOrder = isCreate ? CREATE_TAB_ORDER : EDIT_TAB_ORDER;
              const idx = tabOrder.indexOf(tab);
              if (idx < 0) return;
              let next: AgentsTab | null = null;
              if (event.key === "ArrowDown") {
                next = tabOrder[(idx + 1) % tabOrder.length];
              } else if (event.key === "ArrowUp") {
                next =
                  tabOrder[(idx - 1 + tabOrder.length) % tabOrder.length];
              } else if (event.key === "Home") {
                next = tabOrder[0];
              } else if (event.key === "End") {
                next = tabOrder[tabOrder.length - 1];
              }
              if (next === null) return;
              event.preventDefault();
              tabSwitchSourceRef.current = "keyboard";
              setTab(next);
            }}
          >
            {(
              [
                { key: "overview" as const, label: "身份", dirtyKey: "overview" as DraftTabKey, icon: <IdentityIcon />, count: null as number | null },
                { key: "tools" as const, label: "工具", dirtyKey: "tools" as DraftTabKey, icon: <ToolsIcon />, count: null },
                { key: "skills" as const, label: "技能", dirtyKey: "skills" as DraftTabKey, icon: <SkillsIcon />, count: skillsCount(draft) },
                { key: "handoff" as const, label: "协作", dirtyKey: "handoff" as DraftTabKey, icon: <HandoffIcon />, count: draft.handoffAgentIds.length || null },
                { key: "core" as const, label: "核心文件", dirtyKey: null, icon: <FileIcon />, count: null },
              ].filter((entry) => !isCreate || entry.key !== "core")
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
                    "agent-edit-rail-item" +
                    (tab === entry.key ? " active" : "")
                  }
                  onClick={() => {
                    tabSwitchSourceRef.current = "mouse";
                    setTab(entry.key);
                  }}
                >
                  <span className="agent-edit-rail-icon" aria-hidden="true">
                    {entry.icon}
                  </span>
                  <span className="agent-edit-rail-label">{entry.label}</span>
                  {entry.count !== null && entry.count > 0 ? (
                    <span
                      className="agent-edit-rail-count"
                      aria-label={`${entry.count} 项`}
                    >
                      {entry.count}
                    </span>
                  ) : isDirtyTab ? (
                    <span
                      className="agent-edit-rail-dot"
                      aria-hidden="true"
                      title="有未保存的修改"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="agent-edit-content">
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
              <OverviewTab
                agent={agent}
                draft={draft}
                authStatus={props.authStatus ?? null}
                onChange={setDraft}
              />
            ) : null}
            {tab === "tools" ? (
              <ToolsTab
                draft={draft}
                toolGroups={props.toolGroups}
                onChange={setDraft}
              />
            ) : null}
            {tab === "skills" ? (
              <SkillsTab draft={draft} onChange={setDraft} />
            ) : null}
            {tab === "handoff" ? (
              <HandoffTab
                draft={draft}
                agentId={agent?.id ?? ""}
                agents={props.agents}
                onChange={setDraft}
              />
            ) : null}
            {tab === "core" && !isCreate ? (
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

          {/* Round 25 — preview is bound to the Identity tab.
            * It mirrors fields the user is editing right there
            * (avatar / name / description / 推理); on Tools / Skills
            * / Handoff / Core the preview wouldn't reflect what the
            * user is touching, so we hide it and let the form
            * breathe instead. Same rule in both create + edit. */}
          {tab === "overview" ? (
            <AgentPreviewCard
              agent={agent}
              draft={draft}
              isCreate={isCreate}
            />
          ) : null}
        </div>

        <div className="agent-edit-footer">
          <div className="agent-edit-footer-left">
            {!isCreate ? (
              <SaveStatusIndicator
                saving={saving}
                isDirty={isDirty}
                savedFlash={savedFlash}
              />
            ) : null}
            {!isCreate && isDirty && !saving ? (
              <button
                type="button"
                className="btn-secondary btn-sm agent-edit-revert"
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
          </div>
          <button
            type="button"
            className="btn-primary agent-edit-save"
            disabled={
              saving ||
              !draft.name.trim() ||
              !draft.instructions.trim() ||
              (!isCreate && !isDirty)
            }
            onClick={save}
          >
            {saving ? (
              <>
                <span className="agent-edit-save-spinner" aria-hidden="true" />
                {isCreate ? "创建中…" : "保存中…"}
              </>
            ) : (
              <>
                {isCreate ? "创建" : "保存"}
                <kbd className="agent-edit-save-kbd" aria-hidden="true">
                  ⌘S
                </kbd>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Tab rail icons — light outline, 1.6 stroke, 16px viewBox to match
 * the rest of the modal chrome iconography. */
function IdentityIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="6" r="2.5" />
      <path d="M3 13c.5-2.5 2.7-4 5-4s4.5 1.5 5 4" />
    </svg>
  );
}
function ToolsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 5.5h11M2.5 10.5h11" />
      <circle cx="6" cy="5.5" r="1.4" />
      <circle cx="10" cy="10.5" r="1.4" />
    </svg>
  );
}
function SkillsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 11l-3.3 1.7.7-3.7L2.7 6.4l3.7-.5L8 2.5Z" />
    </svg>
  );
}
function HandoffIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4.5" cy="4.5" r="1.6" />
      <circle cx="11.5" cy="11.5" r="1.6" />
      <path d="M6 5.5h4a3 3 0 0 1 0 6H6" />
    </svg>
  );
}

/**
 * Skill count for the rail's "技能" badge — uses the same parsing
 * semantics as the SkillsTab itself so the badge always reflects what
 * a save would persist.
 *
 *   "" / null → return null (no badge — full access is the default)
 *   "none"    → return null (badge hidden; the empty allowlist is
 *                          shown only inside the tab via "已禁用").
 *   N items   → return N
 */
function skillsCount(draft: Draft): number | null {
  const parsed = parseSkills(draft.skillsText);
  if (parsed === null) return null;
  if (parsed.length === 0) return null;
  return parsed.length;
}
function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.5h5L12.5 6v7a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" />
      <path d="M9 2.5V6h3.5" />
    </svg>
  );
}

/* Map a ReasoningLevel to the friendly Chinese label shown in the
 * preview card's "风格" row. Mirrors the OverviewTab segmented control
 * options so the preview echoes whatever the user just clicked. */
const REASONING_LABELS: Record<string, string> = {
  low: "快速",
  medium: "标准",
  high: "深度",
};

/**
 * Live preview card pinned to the right of the form. Mirrors what
 * the agent will look like in browse / chat surfaces — avatar, name,
 * description, current reasoning style — so the user sees their
 * edits taking effect without saving first.
 *
 * In create mode the preview cross-fades on the typed name (synth
 * agent id falls back to "new-agent" while name is empty so the hue
 * is still deterministic).
 */
function AgentPreviewCard({
  agent,
  draft,
  isCreate,
}: {
  agent: Agent | null;
  draft: Draft;
  isCreate: boolean;
}) {
  const previewAgent = agent ?? {
    id: draft.name.trim() || "new-agent",
    name: draft.name.trim() || "新建智能体",
  };
  const displayName = isCreate
    ? draft.name.trim() || "新建智能体"
    : agent?.name || "未命名智能体";
  const description = draft.description.trim();
  const reasoning = REASONING_LABELS[draft.reasoning] ?? "标准";

  return (
    <aside
      className="agent-edit-preview"
      aria-label="智能体预览"
    >
      <header className="agent-edit-preview-head">
        <span className="agent-edit-preview-dot" aria-hidden="true" />
        <span className="agent-edit-preview-eyebrow">智能体预览</span>
      </header>
      <p className="agent-edit-preview-sub">
        {isCreate ? "实时预览创建效果" : "预览智能体效果"}
      </p>

      <div className="agent-edit-preview-card">
        <div className="agent-edit-preview-avatar">
          <AgentAvatar agent={previewAgent} size={44} shape="square" />
        </div>
        <h3 className="agent-edit-preview-name" title={displayName}>
          {displayName}
        </h3>
        {!isCreate ? (
          <span className="agent-edit-preview-badge" aria-label="身份已验证">
            <CheckBadgeIcon />
            身份已验证
          </span>
        ) : (
          <span
            className="agent-edit-preview-badge agent-edit-preview-badge-draft"
            aria-label="尚未创建"
          >
            草稿
          </span>
        )}
        {description ? (
          <p className="agent-edit-preview-desc">"{description}"</p>
        ) : (
          <p className="agent-edit-preview-desc agent-edit-preview-desc-empty">
            还没有描述。在身份页填写后会显示在这里。
          </p>
        )}
        <hr className="agent-edit-preview-divider" />
        <div className="agent-edit-preview-meta">
          <span className="agent-edit-preview-meta-label">推理</span>
          <span className="agent-edit-preview-meta-value">{reasoning}</span>
        </div>
      </div>
    </aside>
  );
}

function CheckBadgeIcon() {
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
