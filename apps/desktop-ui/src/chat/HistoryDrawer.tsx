import { useEffect, useMemo, useState } from "react";
import type { ConversationDto } from "../api/conversations";

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  items: ReadonlyArray<ConversationDto>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
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
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) setPendingDeleteId(null);
  }, [props.open]);

  useEffect(() => {
    if (!pendingDeleteId) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setPendingDeleteId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingDeleteId]);

  const grouped = useMemo(() => {
    const filtered = props.items.filter((c) =>
      query.trim() ? (c.title || "").toLowerCase().includes(query.toLowerCase()) : true,
    );
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
  }, [props.items, query]);

  if (!props.open) return null;

  function pickAndClose(id: string) {
    props.onSelect(id);
    props.onClose();
  }

  function requestDelete(id: string) {
    setPendingDeleteId(id);
  }

  function confirmDelete(id: string) {
    props.onDelete?.(id);
    setPendingDeleteId(null);
  }

  function cancelDelete() {
    setPendingDeleteId(null);
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
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-tertiary)" }}><circle cx="7" cy="7" r="4.5" /><path d="M14 14l-3.5-3.5" /></svg>
          <input
            placeholder="搜索历史会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="history-list">
          {grouped.length === 0 ? (
            <div className="group-heading">没有匹配的会话</div>
          ) : (
            grouped.map((g) => (
              <div key={g.label}>
                <div className="group-heading">{g.label}</div>
                {g.rows.map((c) => {
                  const pending = c.id === pendingDeleteId;
                  return (
                    <div
                      key={c.id}
                      className={"history-row" + (c.id === props.activeId ? " active" : "")}
                      data-pending-delete={pending ? "true" : undefined}
                    >
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => pickAndClose(c.id)}
                      >
                        <span className="row-title">{c.title || "(无标题)"}</span>
                        <span className="row-meta">{new Date(c.updatedAt).toLocaleString()}</span>
                      </button>
                      {props.onDelete ? (
                        pending ? (
                          <span className="delete-confirm">
                            <button
                              type="button"
                              className="cancel"
                              aria-label="取消删除"
                              onClick={cancelDelete}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="confirm"
                              aria-label="确认删除"
                              onClick={() => confirmDelete(c.id)}
                            >
                              删除
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="row-delete"
                            aria-label="删除"
                            title="删除"
                            onClick={() => requestDelete(c.id)}
                          >
                            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 4.5v8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-8" /></svg>
                          </button>
                        )
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
