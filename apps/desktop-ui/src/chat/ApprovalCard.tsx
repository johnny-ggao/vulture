import type { ApprovalDecision } from "../api/runs";

export interface ApprovalCardProps {
  callId: string;
  tool: string;
  reason: string;
  submitting: boolean;
  onDecide: (callId: string, decision: ApprovalDecision) => void;
}

export function ApprovalCard(props: ApprovalCardProps) {
  return (
    <div className="approval-card">
      <div className="approval-card-header">
        <WarningIcon />
        <strong>需要批准 · {props.tool}</strong>
      </div>
      <p className="approval-card-reason">{props.reason}</p>
      <div className="approval-card-actions">
        <button
          type="button"
          className="approval-card-deny"
          onClick={() => props.onDecide(props.callId, "deny")}
          disabled={props.submitting}
        >
          {props.submitting ? "处理中…" : "拒绝"}
        </button>
        <button
          type="button"
          className="approval-card-allow"
          onClick={() => props.onDecide(props.callId, "allow")}
          disabled={props.submitting}
        >
          {props.submitting ? "处理中…" : "允许"}
        </button>
      </div>
    </div>
  );
}

function WarningIcon() {
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
      <path d="M7.13 2.5l-5.4 9.4A1 1 0 0 0 2.6 13.5h10.8a1 1 0 0 0 .87-1.6l-5.4-9.4a1 1 0 0 0-1.74 0z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
    </svg>
  );
}
