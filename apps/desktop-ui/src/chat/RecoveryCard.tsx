export interface RecoveryCardProps {
  message: string;
  busy: boolean;
  onResume: () => void;
  onCancel: () => void;
}

/**
 * Inline card shown when the run reaches a recoverable state — i.e.
 * the gateway lost the upstream connection mid-tool but still has the
 * draft state on disk. The user picks: resume from where we left off,
 * or cancel and start over.
 *
 * Visual tone: info (blue), not warning. Resuming is the expected
 * happy path so it gets the brand-coloured primary button; Cancel
 * stays a quiet ghost. Mirrors the ApprovalCard hierarchy so users
 * can scan both quickly.
 */
export function RecoveryCard(props: RecoveryCardProps) {
  return (
    <aside className="recovery-card" role="alert" aria-busy={props.busy}>
      <header className="recovery-card-header">
        <span className="recovery-card-icon" aria-hidden="true">
          <RefreshIcon />
        </span>
        <strong>可恢复运行</strong>
      </header>
      <p className="recovery-card-message">{props.message}</p>
      <div className="recovery-card-actions">
        <button
          type="button"
          className="recovery-card-cancel"
          aria-label="取消恢复"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="recovery-card-resume"
          aria-label="恢复运行"
          disabled={props.busy}
          onClick={props.onResume}
        >
          {props.busy ? "恢复中…" : "恢复"}
        </button>
      </div>
    </aside>
  );
}

function RefreshIcon() {
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
      <path d="M2.5 8a5.5 5.5 0 0 1 9.5-3.8" />
      <path d="M13.5 2.5v3h-3" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.5 3.8" />
      <path d="M2.5 13.5v-3h3" />
    </svg>
  );
}
