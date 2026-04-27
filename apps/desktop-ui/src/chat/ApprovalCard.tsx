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
        <span aria-hidden="true">⚠️</span>
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
