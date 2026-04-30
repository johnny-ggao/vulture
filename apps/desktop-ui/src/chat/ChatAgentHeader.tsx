import type { RunStreamStatus } from "../hooks/useRunStream";
import { AgentAvatar, useCursorGloss } from "./components";

export interface ChatAgentHeaderProps {
  agent: { id: string; name: string };
  runStatus: RunStreamStatus;
  resuming: boolean;
}

/**
 * True when a run is in any active phase. Single source of truth so
 * ChatView, ChatAgentHeader, and any future consumer agree on what
 * "running" means — adding a new status to the union forces an update
 * here and the type-check ripples to every call site.
 */
export function isRunningStatus(
  status: RunStreamStatus,
  resuming: boolean,
): boolean {
  return (
    resuming ||
    status === "connecting" ||
    status === "streaming" ||
    status === "reconnecting" ||
    status === "recoverable"
  );
}

/**
 * Sticky strip at the top of the chat surface that names the active agent
 * and surfaces an in-flight indicator when a run is going. The strip
 * carries its own cursor-tracked spotlight (same idiom as AgentCard) so it
 * reads as a "live" surface, not a static label.
 *
 * Caller decides when to render this — typically only when there are
 * messages and an active agent is in scope. The component itself does
 * not gate on emptiness; that lets the parent's layout decide.
 */
export function ChatAgentHeader({
  agent,
  runStatus,
  resuming,
}: ChatAgentHeaderProps) {
  const running = isRunningStatus(runStatus, resuming);
  const statusLabel = runStatusLabel(runStatus, resuming);
  const { ref, ...gloss } = useCursorGloss<HTMLDivElement>();

  return (
    <div className="chat-agent-header" ref={ref} {...gloss}>
      <AgentAvatar agent={agent} size={28} shape="square" />
      <div className="chat-agent-meta">
        <span className="chat-agent-name">{agent.name}</span>
        {running ? (
          <span className="chat-agent-status" aria-live="polite">
            <span className="chat-agent-status-dot" aria-hidden="true" />
            {statusLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Map a `RunStreamStatus` to a Chinese label for the chat header status
 * pill. Exhaustive over the union — adding a new status will surface a
 * TypeScript error at the `_exhaustive` line so we don't silently fall
 * through to "处理中". Module-private — only `ChatAgentHeader` needs it.
 */
function runStatusLabel(
  status: RunStreamStatus,
  resuming: boolean,
): string {
  if (resuming) return "恢复中";
  switch (status) {
    case "streaming":    return "回应中";
    case "reconnecting": return "重连中";
    case "recoverable":  return "等待恢复";
    case "connecting":   return "连接中";
    // Terminal / quiescent states never display the indicator (the call
    // site gates on `running`), but listing them here makes the switch
    // exhaustive: a new RunStreamStatus value would fail to compile.
    case "idle":
    case "succeeded":
    case "failed":
    case "cancelled":
      return "处理中";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
