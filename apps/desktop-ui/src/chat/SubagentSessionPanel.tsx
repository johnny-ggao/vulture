import { useState } from "react";
import type { MessageDto } from "../api/conversations";
import type { SubagentSessionDto, SubagentSessionStatus } from "../api/subagentSessions";
import { AgentAvatar } from "./components";

export interface SubagentSessionPanelProps {
  sessions: ReadonlyArray<SubagentSessionDto>;
  messagesBySessionId: Readonly<Record<string, ReadonlyArray<MessageDto>>>;
  loadingSessionIds: ReadonlySet<string>;
  onLoadMessages: (sessionId: string) => void | Promise<void>;
}

/**
 * Inline panel listing the subagent sessions spawned by the current run.
 * Each row is collapsible — clicking expands it inline (via aria-expanded)
 * and lazily loads the conversation messages on first open.
 *
 * Visual language matches ToolBlock (round 9): SVG chevron, per-row
 * status pill, and a subtle inline expansion that doesn't pull the
 * focus away from the parent run stream.
 */
export function SubagentSessionPanel(props: SubagentSessionPanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  if (props.sessions.length === 0) return null;

  return (
    <section className="subagent-panel" aria-label="子任务">
      <header className="subagent-panel-head">
        <div>
          <h3>子任务</h3>
          <p>{props.sessions.length} 个任务</p>
        </div>
      </header>
      <div className="subagent-list">
        {props.sessions.map((session) => {
          const open = expanded.has(session.id);
          const messages = props.messagesBySessionId[session.id] ?? [];
          const loading = props.loadingSessionIds.has(session.id);
          const title = session.title || session.label || session.agentId;
          const secondary = session.task || `${session.agentId} · ${formatMessageCount(session.messageCount)}`;
          const detail = statusDetail(session);
          const subagent = {
            id: session.agentId,
            name: session.label || session.agentId,
          };
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
                <span className="subagent-chevron" aria-hidden="true">
                  <ChevronIcon open={open} />
                </span>
                <span className="subagent-avatar" aria-hidden="true">
                  <AgentAvatar agent={subagent} size={22} shape="square" />
                </span>
                <span className="subagent-main">
                  <strong>{title}</strong>
                  <span className="subagent-secondary">{secondary}</span>
                  {detail ? <span className={`subagent-detail ${session.status}`}>{detail}</span> : null}
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

function statusDetail(session: SubagentSessionDto): string | null {
  if (session.status === "completed" && session.resultSummary) {
    return session.resultSummary;
  }
  if (session.status === "failed" || session.status === "cancelled") {
    const error = normalizeInlineError(session.lastError);
    if (!error) return null;
    const fallbackToken = session.status === "failed" ? "failed" : "cancelled";
    if (error.toLowerCase() === fallbackToken) return null;
    return error;
  }
  return null;
}

function normalizeInlineError(value: string | null): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function ChevronIcon({ open }: { open: boolean }) {
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
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 160ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}
    >
      <path d="M5.5 3l5 5-5 5" />
    </svg>
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
