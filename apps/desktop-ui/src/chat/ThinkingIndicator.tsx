import { AgentAvatar } from "./components";

export interface ThinkingIndicatorProps {
  /**
   * Optional agent context used to render a tinted avatar matching the
   * one the eventual MessageBubble will use. Falls back to the V-letter
   * circle when omitted, mirroring MessageBubble's default avatar.
   */
  agent?: { id: string; name: string };
}

/**
 * Pre-stream "thinking" affordance. Shown by RunEventStream when the
 * run is active (streaming) but no assistant text block has landed yet
 * — the gap between user pressing Enter and the first SSE token is
 * otherwise visually empty, which reads as "stuck".
 *
 * Visual: same avatar slot as MessageBubble + a row of 3 staggered
 * pulsing dots. Reduced motion replaces the pulse with a single static
 * "思考中…" word so the affordance still communicates intent without
 * triggering motion sensitivity.
 */
export function ThinkingIndicator({ agent }: ThinkingIndicatorProps) {
  return (
    <article
      className="message assistant message-thinking"
      aria-live="polite"
      aria-label="智能体正在思考"
    >
      {agent ? (
        <div className="message-avatar message-avatar-agent">
          <AgentAvatar agent={agent} size={32} shape="square" />
        </div>
      ) : (
        <div className="message-avatar">V</div>
      )}
      <div className="message-bubble">
        <div className="thinking-dots" aria-hidden="true">
          <span /><span /><span />
        </div>
        <span className="thinking-fallback">思考中…</span>
      </div>
    </article>
  );
}
