import type { ReactNode } from "react";
import type { ConversationDto } from "../api/conversations";

export interface ConversationListProps {
  items: ReadonlyArray<ConversationDto>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  footerSlot?: ReactNode;
}

export function ConversationList(props: ConversationListProps) {
  return (
    <aside className="chat-sidebar">
      <div className="window-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="brand">
        <div className="brand-mark">V</div>
        <strong>Vulture Work</strong>
      </div>

      <button type="button" className="nav-item active" onClick={props.onNew}>
        <span>+</span>新消息
      </button>

      <section className="conversation-list">
        <p>会话</p>
        {props.items.length === 0 ? (
          <p className="empty">还没有会话，点击上方"+ 新消息"开始</p>
        ) : (
          props.items.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`conversation ${c.id === props.activeId ? "active" : ""}`}
              onClick={() => props.onSelect(c.id)}
            >
              <span className="mini-mark">V</span>
              {c.title || "(无标题)"}
            </button>
          ))
        )}
      </section>

      {props.footerSlot ? (
        <div className="chat-sidebar-footer">{props.footerSlot}</div>
      ) : null}
    </aside>
  );
}
