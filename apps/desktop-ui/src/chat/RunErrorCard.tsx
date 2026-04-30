export interface RunErrorCardProps {
  /** Stable error code from the gateway (e.g. "internal", "rate_limited"). */
  code: string;
  /**
   * Human-readable error message. Test contract: when rendered, the card
   * MUST contain the literal text `运行失败：{message}` somewhere in its
   * subtree so the existing run-stream test (which asserts on the exact
   * "运行失败：Connection error." substring) keeps passing.
   */
  message: string;
}

/**
 * Inline error card surfaced when the run terminates with `run.failed`.
 * Replaces the older "render the failure as another assistant bubble"
 * shim — that pattern was visually indistinguishable from the agent's
 * own output, which made it easy to mistake for content.
 *
 * Layout intent: a quiet danger surface (border + tinted background)
 * with the code as a monospace pill on the right. The message is
 * selectable so users can copy it into a bug report.
 */
export function RunErrorCard({ code, message }: RunErrorCardProps) {
  return (
    <aside className="run-error-card" role="alert">
      <span className="run-error-card-icon" aria-hidden="true">
        <AlertIcon />
      </span>
      <div className="run-error-card-body">
        <strong className="run-error-card-title">运行失败：{message}</strong>
        <code className="run-error-card-code">{code}</code>
      </div>
    </aside>
  );
}

function AlertIcon() {
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
