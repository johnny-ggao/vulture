export interface ErrorAlertProps {
  message: string | null | undefined;
}

/**
 * Inline error banner with `role="alert"` so screen readers announce it
 * immediately. Renders nothing when message is empty / null / undefined.
 */
export function ErrorAlert({ message }: ErrorAlertProps) {
  if (!message) return null;
  return (
    <div role="alert" className="error-alert">
      <ErrorIcon />
      <span>{message}</span>
    </div>
  );
}

function ErrorIcon() {
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
