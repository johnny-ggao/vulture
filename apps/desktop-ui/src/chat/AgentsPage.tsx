import { useEffect, useMemo, useState } from "react";
import type { Agent, AgentCoreFilesResponse } from "../api/agents";
import type { ToolCatalogGroup } from "../api/tools";
import type { AuthStatusView } from "../commandCenterTypes";
import { AgentCard, AgentCreateTile, SearchInput, SectionCard } from "./components";
import {
  AgentEditModal,
  type AgentConfigPatch,
  type AgentsTab,
} from "./AgentEditModal";

export type { AgentConfigPatch };

type AgentSort = "recent" | "alpha" | "tools";

interface SortOption {
  value: AgentSort;
  label: string;
}

const SORT_OPTIONS: ReadonlyArray<SortOption> = [
  { value: "recent", label: "最近更新" },
  { value: "alpha", label: "名称" },
  { value: "tools", label: "工具数量" },
];

/**
 * Round 17: persist the user's browse preferences (sort + search)
 * across sessions via localStorage so navigating away and coming
 * back doesn't reset their working view. Wrapped in try/catch
 * because some hosts (private mode, Tauri webview without storage
 * permission) reject access; we silently fall back to the default.
 */
const STORAGE_KEY_SORT = "vulture.agents.sort";
const STORAGE_KEY_SEARCH = "vulture.agents.search";

function readStoredSort(): AgentSort {
  try {
    const value = localStorage.getItem(STORAGE_KEY_SORT);
    if (value === "recent" || value === "alpha" || value === "tools") {
      return value;
    }
  } catch {
    // localStorage unavailable — keep default.
  }
  return "recent";
}

function readStoredSearch(): string {
  try {
    return localStorage.getItem(STORAGE_KEY_SEARCH) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // best-effort; silent on storage failure.
  }
}

export interface AgentsPageProps {
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  /**
   * Auth state piped through from the app shell so the per-agent model
   * picker can show only the configured ("已验证") providers' models.
   */
  authStatus?: AuthStatusView | null;
  /** Persists a brand-new agent. Drives the AgentEditModal in create mode. */
  onCreate: (patch: AgentConfigPatch) => Promise<void>;
  onOpenChat: (id: string) => void;
  onSave: (id: string, patch: AgentConfigPatch) => Promise<void>;
  onListFiles: (id: string) => Promise<AgentCoreFilesResponse>;
  onLoadFile: (id: string, name: string) => Promise<string>;
  onSaveFile: (id: string, name: string, content: string) => Promise<void>;
  /**
   * Optional one-tap delete handler. The parent owns the undo affordance
   * (typically a transient toast); the list dispatches immediately.
   */
  onDelete?: (id: string) => void;
  /**
   * When set, AgentsPage will open the AgentEditModal for the specified
   * agent on the specified tab on mount (or when the value changes).
   * Used by the App shell to navigate from the CodingAgentBanner click
   * directly into the edit modal.
   */
  initialEditTarget?: { agentId: string; tab: AgentsTab } | null;
}

/**
 * Browse view for the user's agents. Each agent is a card in a responsive
 * grid; clicking a card opens the edit modal. Heavy editor logic lives in
 * `AgentEditModal` so this component stays focused on browse + create.
 */
export function AgentsPage(props: AgentsPageProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // Tracks the tab that should be pre-selected when the modal opens via
  // an external trigger (e.g. CodingAgentBanner click from ChatView).
  const [initialTab, setInitialTab] = useState<AgentsTab | undefined>(undefined);
  // Whether the AgentEditModal is open in create mode. Mutually
  // exclusive with editingId — clicking "新建智能体" sets this true,
  // and the same modal renders with `agent={null}` + onCreate.
  const [creating, setCreating] = useState(false);
  // Round 17 — initialise from localStorage so prefs survive navigation
  // (functional initial-state form so the read happens once, not on
  // every render).
  const [search, setSearch] = useState<string>(() => readStoredSearch());
  const [sort, setSort] = useState<AgentSort>(() => readStoredSort());

  // Round 17 — write back on change. Search is debounced via React's
  // "no work if same value" — write happens every keystroke but
  // localStorage writes are cheap on small strings.
  useEffect(() => {
    writeStored(STORAGE_KEY_SORT, sort);
  }, [sort]);
  useEffect(() => {
    writeStored(STORAGE_KEY_SEARCH, search);
  }, [search]);

  // Open the modal for the specified agent+tab when the App shell passes
  // in an initialEditTarget (e.g. after the user clicks the CodingAgentBanner).
  // The effect fires once per distinct target reference — App.tsx holds
  // this in useState so it's stable until the user triggers it again.
  useEffect(() => {
    if (props.initialEditTarget) {
      setEditingId(props.initialEditTarget.agentId);
      setInitialTab(props.initialEditTarget.tab);
    }
  }, [props.initialEditTarget]);

  const editingAgent =
    editingId !== null
      ? props.agents.find((agent) => agent.id === editingId) ?? null
      : null;

  // Derived list: filter by search across name + description + id, then
  // sort by the chosen column. The id-fallback in the search predicate
  // means users can paste a known id to jump to a specific agent even
  // when its name is empty.
  const visibleAgents = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = !query
      ? props.agents.slice()
      : props.agents.filter((agent) => {
          const haystack =
            `${agent.name ?? ""} ${agent.description ?? ""} ${agent.id}`.toLowerCase();
          return haystack.includes(query);
        });
    const sorted = filtered.slice();
    if (sort === "alpha") {
      sorted.sort((a, b) =>
        (a.name || a.id).localeCompare(b.name || b.id, "zh-Hans-CN"),
      );
    } else if (sort === "tools") {
      sorted.sort((a, b) => b.tools.length - a.tools.length);
    } else {
      // recent: updatedAt fallback to createdAt; missing both → end of list
      sorted.sort((a, b) => {
        const at = parseTimestamp(a.updatedAt ?? a.createdAt);
        const bt = parseTimestamp(b.updatedAt ?? b.createdAt);
        return bt - at;
      });
    }
    return sorted;
  }, [props.agents, search, sort]);

  // If the agent currently being edited is removed (e.g. an undo-toast
  // commit), close the modal rather than letting it render an empty shell.
  useEffect(() => {
    if (editingId !== null && !props.agents.some((a) => a.id === editingId)) {
      setEditingId(null);
    }
  }, [editingId, props.agents]);

  // Save handler for the unified modal: dispatches into the create or
  // edit code path based on whether `agent` was passed.
  async function handleCreate(patch: AgentConfigPatch) {
    await props.onCreate(patch);
    setCreating(false);
  }

  const modalOpen = creating || editingAgent !== null;

  if (props.agents.length === 0) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1>智能体</h1>
            <p>每个智能体捆绑模型、工具权限与人格设置，用来开启不同场景的对话。</p>
          </div>
        </header>
        <SectionCard className="agents-empty-page">
          <div className="agents-empty-art" aria-hidden="true">
            <EmptyAgentsIllustration />
          </div>
          <h2 className="agents-empty-title">还没有智能体</h2>
          <p className="agents-empty-desc">
            智能体捆绑模型、工具权限、Skills 与人格设置；按用途创建一个开始对话。
          </p>
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            创建第一个智能体
          </button>
        </SectionCard>

        <AgentEditModal
          open={modalOpen}
          agent={creating ? null : editingAgent}
          agents={props.agents}
          toolGroups={props.toolGroups}
          authStatus={props.authStatus ?? null}
          initialTab={initialTab}
          onClose={() => {
            setEditingId(null);
            setCreating(false);
            setInitialTab(undefined);
          }}
          onSave={props.onSave}
          onCreate={handleCreate}
          onListFiles={props.onListFiles}
          onLoadFile={props.onLoadFile}
          onSaveFile={props.onSaveFile}
        />
      </div>
    );
  }

  const totalCount = props.agents.length;
  const visibleCount = visibleAgents.length;
  const hasFilter = search.trim().length > 0;
  const filteredEmpty = hasFilter && visibleCount === 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>智能体</h1>
          <p>每个智能体捆绑模型、工具权限与人格设置，用来开启不同场景的对话。</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          新建智能体
        </button>
      </header>

      <div className="agents-toolbar" role="toolbar" aria-label="智能体筛选与排序">
        <div className="agents-toolbar-search">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="按名称 / 描述 / ID 搜索…"
            ariaLabel="搜索智能体"
            shortcut
          />
        </div>
        <div className="agents-toolbar-meta">
          <span className="agents-toolbar-count" aria-live="polite">
            {hasFilter
              ? `${visibleCount} / ${totalCount}`
              : `${totalCount} 个智能体`}
          </span>
          <div
            className="agents-toolbar-sort"
            role="radiogroup"
            aria-label="排序方式"
          >
            <span className="agents-toolbar-sort-label">排序</span>
            <div className="agents-sort-segmented">
              {SORT_OPTIONS.map((option) => {
                const active = option.value === sort;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={
                      "agents-sort-segment" + (active ? " active" : "")
                    }
                    onClick={() => setSort(option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {filteredEmpty ? (
        <SectionCard className="agents-empty-page">
          <div className="agents-empty-art" aria-hidden="true">
            <EmptySearchIllustration />
          </div>
          <h2 className="agents-empty-title">没有匹配的智能体</h2>
          <p className="agents-empty-desc">
            尝试调整关键词，或清空搜索查看全部 {totalCount} 个智能体。
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setSearch("")}
          >
            查看全部智能体
          </button>
        </SectionCard>
      ) : (
        <div className="agents-grid">
          {/* Always-visible "新建智能体" tile lives inside the grid so
            * the affordance is right where the user is browsing —
            * matches Accio's pattern. The page-header `+ 新建智能体`
            * button stays for keyboard parity. */}
          <AgentCreateTile onClick={() => setCreating(true)} />
          {visibleAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onOpenEdit={(id) => setEditingId(id)}
              onOpenChat={props.onOpenChat}
              onDelete={props.onDelete}
            />
          ))}
        </div>
      )}

      <AgentEditModal
        open={modalOpen}
        agent={creating ? null : editingAgent}
        agents={props.agents}
        toolGroups={props.toolGroups}
        authStatus={props.authStatus ?? null}
        initialTab={initialTab}
        onClose={() => {
          setEditingId(null);
          setCreating(false);
          setInitialTab(undefined);
        }}
        onSave={props.onSave}
        onCreate={handleCreate}
        onListFiles={props.onListFiles}
        onLoadFile={props.onLoadFile}
        onSaveFile={props.onSaveFile}
      />
    </div>
  );
}

function EmptyAgentsIllustration() {
  return (
    <svg
      viewBox="0 0 96 96"
      width="96"
      height="96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="14" y="22" width="68" height="42" rx="8" />
      <rect x="22" y="14" width="52" height="6" rx="3" />
      <circle cx="28" cy="38" r="6" />
      <path d="M40 36h26" />
      <path d="M40 44h18" />
      <path d="M28 56h36" />
    </svg>
  );
}

function EmptySearchIllustration() {
  return (
    <svg
      viewBox="0 0 96 96"
      width="96"
      height="96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="42" cy="42" r="22" />
      <path d="M58 58l16 16" />
      <path d="M34 38h16" />
      <path d="M34 46h10" />
    </svg>
  );
}

function parseTimestamp(input: string | undefined): number {
  if (!input) return 0;
  const t = new Date(input).getTime();
  return Number.isNaN(t) ? 0 : t;
}
