import { useState } from "react";
import type { MessageDto } from "../api/conversations";
import type { SubagentSessionDto, SubagentSessionStatus } from "../api/subagentSessions";

export interface SubagentSessionPanelProps {
  sessions: ReadonlyArray<SubagentSessionDto>;
  messagesBySessionId: Readonly<Record<string, ReadonlyArray<MessageDto>>>;
  loadingSessionIds: ReadonlySet<string>;
  onLoadMessages: (sessionId: string) => void | Promise<void>;
}

export function SubagentSessionPanel(props: SubagentSessionPanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  if (props.sessions.length === 0) return null;

  return (
    <section className="subagent-panel" aria-label="子智能体会话">
      <header className="subagent-panel-head">
        <div>
          <h3>子智能体</h3>
          <p>{props.sessions.length} 个会话</p>
        </div>
      </header>
      <div className="subagent-list">
        {props.sessions.map((session) => {
          const open = expanded.has(session.id);
          const messages = props.messagesBySessionId[session.id] ?? [];
          const loading = props.loadingSessionIds.has(session.id);
          return (
            <article className="subagent-item" key={session.id} data-status={session.status}>
              <button
                type="button"
                className="subagent-row"
                aria-expanded={open}
                onClick={() => {
                  const next = new Set(expanded);
                  if (open) {
                    next.delete(session.id);
                  } else {
                    next.add(session.id);
                    void props.onLoadMessages(session.id);
                  }
                  setExpanded(next);
                }}
              >
                <span className="subagent-chevron" aria-hidden="true">{open ? "▼" : "▶"}</span>
                <span className="subagent-main">
                  <strong>{session.label || session.agentId}</strong>
                  <span>
                    {session.agentId} · {formatMessageCount(session.messageCount)}
                  </span>
                </span>
                <span className={`subagent-status ${session.status}`}>
                  {statusLabel(session.status)}
                </span>
              </button>
              {open ? (
                <div className="subagent-messages">
                  {loading ? <p className="subagent-empty">加载中…</p> : null}
                  {!loading && messages.length === 0 ? (
                    <p className="subagent-empty">暂无消息</p>
                  ) : null}
                  {messages.map((message) => (
                    <div className={`subagent-message ${message.role}`} key={message.id}>
                      <span className="subagent-message-role">{roleLabel(message.role)}</span>
                      <p>{message.content}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function statusLabel(status: SubagentSessionStatus): string {
  switch (status) {
    case "active":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function roleLabel(role: MessageDto["role"]): string {
  switch (role) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "system":
      return "系统";
  }
}

function formatMessageCount(count: number): string {
  return `${count.toLocaleString("zh-CN")} 条消息`;
}
