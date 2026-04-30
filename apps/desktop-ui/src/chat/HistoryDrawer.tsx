import { useMemo, useState } from "react";
import type { ConversationDto } from "../api/conversations";
import { AgentAvatar } from "./components";

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  items: ReadonlyArray<ConversationDto>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /**
   * Optional roster of agents the conversations may reference. When
   * provided, each row renders the originating agent's avatar so users
   * can spot which agent owns which conversation at a glance. Rows whose
   * `agentId` doesn't resolve fall back to a no-avatar layout.
   */
  agents?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Called when the user clicks the row's delete affordance. The drawer
   * dispatches immediately and lets the parent surface an undo path
   * (typically a transient toast).
   */
  onDelete?: (id: string) => void;
}

function bucketFor(updatedAt: string): string {
  const ts = new Date(updatedAt).getTime();
  if (Number.isNaN(ts)) return "更早";
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  if (now - ts < oneDay) return "今天";
  if (now - ts < 2 * oneDay) return "昨天";
  if (now - ts < 7 * oneDay) return "本周";
  return "更早";
}

export function HistoryDrawer(props: HistoryDrawerProps) {
  const [query, setQuery] = useState("");
  // null = "all agents"; an id pins the list to one agent's conversations.
  // Reset whenever the drawer closes so reopening lands on a clean view.
  const [agentFilterId, setAgentFilterId] = useState<string | null>(null);

  // O(1) agent lookup for row rendering. Memoised so the map identity is
  // stable across re-renders when the agents array hasn't changed.
  const agentById = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    if (props.agents) {
      for (const agent of props.agents) map.set(agent.id, agent);
    }
    return map;
  }, [props.agents]);

  // Only show filter chips for agents that actually have conversations in
  // the current item set — avoids pinning to an empty result.
  const agentsWithConversations = useMemo(() => {
    if (!props.agents) return [] as Array<{ id: string; name: string; count: number }>;
    const counts = new Map<string, number>();
    for (const c of props.items) {
      counts.set(c.agentId, (counts.get(c.agentId) ?? 0) + 1);
    }
    return props.agents
      .filter((agent) => counts.has(agent.id))
      .map((agent) => ({ ...agent, count: counts.get(agent.id) ?? 0 }));
  }, [props.agents, props.items]);

  // If the pinned agent has no remaining conversations (e.g. last one was
  // deleted), drop the filter rather than showing an empty list.
  if (
    agentFilterId !== null &&
    !agentsWithConversations.some((a) => a.id === agentFilterId)
  ) {
    setAgentFilterId(null);
  }

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = props.items.filter((c) => {
      if (agentFilterId !== null && c.agentId !== agentFilterId) return false;
      if (q && !(c.title || "").toLowerCase().includes(q)) return false;
      return true;
    });
    const map = new Map<string, ConversationDto[]>();
    const order: string[] = [];
    for (const c of filtered) {
      const b = bucketFor(c.updatedAt);
      if (!map.has(b)) {
        map.set(b, []);
        order.push(b);
      }
      map.get(b)!.push(c);
    }
    return order.map((label) => ({ label, rows: map.get(label)! }));
  }, [props.items, query, agentFilterId]);

  if (!props.open) return null;

  function pickAndClose(id: string) {
    props.onSelect(id);
    props.onClose();
  }

  return (
    <div className="history-drawer-overlay" onClick={props.onClose}>
      <div className="history-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="history-drawer-header">
          <span className="title">历史</span>
          <div className="actions">
            <button
              type="button"
              className="icon-btn"
              title="新建对话"
              onClick={() => {
                props.onNew();
                props.onClose();
              }}
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v10M3 8h10" /></svg>
            </button>
            <button type="button" className="icon-btn" title="关闭" onClick={props.onClose}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M4 12l8-8" /></svg>
            </button>
          </div>
        </div>
        <div className="search-field">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="search-field-icon"><circle cx="7" cy="7" r="4.5" /><path d="M14 14l-3.5-3.5" /></svg>
          <input
            placeholder="搜索历史会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {agentsWithConversations.length >= 2 ? (
          <div
            className="history-filter-chips"
            role="tablist"
            aria-label="按智能体筛选"
          >
            <button
              type="button"
              role="tab"
              aria-selected={agentFilterId === null}
              className={
                "history-filter-chip" + (agentFilterId === null ? " active" : "")
              }
              onClick={() => setAgentFilterId(null)}
            >
              <span className="history-filter-label">全部</span>
              <span className="history-filter-count">{props.items.length}</span>
            </button>
            {agentsWithConversations.map((agent) => (
              <button
                key={agent.id}
                type="button"
                role="tab"
                aria-selected={agentFilterId === agent.id}
                className={
                  "history-filter-chip" +
                  (agentFilterId === agent.id ? " active" : "")
                }
                onClick={() => setAgentFilterId(agent.id)}
                title={agent.name}
              >
                <AgentAvatar agent={agent} size={16} shape="square" />
                <span className="history-filter-label">{agent.name}</span>
                <span className="history-filter-count">{agent.count}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="history-list">
          {grouped.length === 0 ? (
            <div className="group-heading">没有匹配的会话</div>
          ) : (
            grouped.map((g) => (
              <div key={g.label}>
                <div className="group-heading">{g.label}</div>
                {g.rows.map((c) => {
                  const agent = agentById.get(c.agentId);
                  return (
                  <div
                    key={c.id}
                    className={"history-row" + (c.id === props.activeId ? " active" : "")}
                  >
                    <button
                      type="button"
                      className="row-button"
                      onClick={() => pickAndClose(c.id)}
                    >
                      {/* When the row's agent isn't in scope (e.g. it was
                       * deleted), AgentAvatar still renders a glyph from the
                       * agentId's hue + a "?" fallback letter so column
                       * alignment stays consistent with rows that do have
                       * a known agent. */}
                      <AgentAvatar
                        agent={agent ?? { id: c.agentId, name: "" }}
                        size={20}
                        shape="square"
                      />
                      <span className="row-text">
                        <span className="row-title">{c.title || "(无标题)"}</span>
                        <span className="row-meta">{new Date(c.updatedAt).toLocaleString()}</span>
                      </span>
                    </button>
                    {props.onDelete ? (
                      <button
                        type="button"
                        className="row-delete"
                        aria-label="删除"
                        title="删除"
                        onClick={() => props.onDelete?.(c.id)}
                      >
                        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 4.5v8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-8" /></svg>
                      </button>
                    ) : null}
                  </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
