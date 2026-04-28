export interface RecoveryCardProps {
  message: string;
  busy: boolean;
  onResume: () => void;
  onCancel: () => void;
}

export function RecoveryCard(props: RecoveryCardProps) {
  return (
    <div className="recovery-card">
      <div className="recovery-card-header">
        <strong>可恢复</strong>
      </div>
      <p>{props.message}</p>
      <div className="recovery-card-actions">
        <button
          type="button"
          className="recovery-card-resume"
          aria-label="恢复运行"
          disabled={props.busy}
          onClick={props.onResume}
        >
          {props.busy ? "恢复中..." : "恢复"}
        </button>
        <button
          type="button"
          className="recovery-card-cancel"
          aria-label="取消恢复"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}
