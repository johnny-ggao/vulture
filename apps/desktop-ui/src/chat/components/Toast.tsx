import type { ReactNode } from "react";

export interface ToastProps {
  /** Visible message. */
  message: ReactNode;
  /**
   * Optional action button label + handler. Use for "撤销", "重试", etc.
   * The handler MUST clear the toast itself; Toast does not auto-dismiss
   * after action click, so the parent decides what happens next.
   */
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Click handler for the dismiss `×`. Toast is hidden by parent. */
  onDismiss: () => void;
  /**
   * Visual tone. Defaults to "neutral". Critical errors should use
   * "danger"; success confirmations "success".
   */
  tone?: "neutral" | "danger" | "success" | "warning";
}

/**
 * Transient bottom-bar notification. Pure presentation — the caller owns
 * the lifetime (auto-dismiss timer, queueing, etc.).
 *
 * Uses role="status" + aria-live="polite" so screen readers announce the
 * message without stealing focus. Action buttons remain reachable by tab.
 */
export function Toast({ message, action, onDismiss, tone = "neutral" }: ToastProps) {
  return (
    <div className={`toast toast-${tone}`} role="status" aria-live="polite">
      <span className="toast-message">{message}</span>
      {action ? (
        <button
          type="button"
          className="toast-action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="toast-dismiss"
        aria-label="关闭通知"
        onClick={onDismiss}
      >
        <DismissIcon />
      </button>
    </div>
  );
}

function DismissIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
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
