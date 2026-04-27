import { useCallback, useMemo, useState } from "react";
import type { ApiClient } from "../api/client";
import { runsApi, type ApprovalDecision } from "../api/runs";
import type { AnyRunEvent } from "./useRunStream";

export interface PendingApproval {
  callId: string;
  tool: string;
  reason: string;
  approvalToken: string;
  seq: number;
}

export function extractPendingApprovals(events: readonly AnyRunEvent[]): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  for (const e of events) {
    if (e.type === "tool.ask") {
      pending.set(String(e.callId), {
        callId: String(e.callId),
        tool: String(e.tool ?? ""),
        reason: String(e.reason ?? ""),
        approvalToken: String(e.approvalToken ?? ""),
        seq: e.seq,
      });
    } else if (e.type === "run.cancelled") {
      pending.clear();
    } else if (
      (e.type === "tool.completed" || e.type === "tool.failed") &&
      e.callId !== undefined
    ) {
      pending.delete(String(e.callId));
    }
  }
  return [...pending.values()];
}

export interface UseApprovalOptions {
  client: ApiClient | null;
  runId: string | null;
  events: readonly AnyRunEvent[];
}

export function useApproval(opts: UseApprovalOptions) {
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());
  const pending = useMemo(() => extractPendingApprovals(opts.events), [opts.events]);

  const decide = useCallback(
    async (callId: string, decision: ApprovalDecision) => {
      if (!opts.client || !opts.runId) return;
      setSubmitting((prev) => new Set(prev).add(callId));
      try {
        await runsApi.approve(opts.client, opts.runId, { callId, decision });
      } finally {
        setSubmitting((prev) => {
          const next = new Set(prev);
          next.delete(callId);
          return next;
        });
      }
    },
    [opts.client, opts.runId],
  );

  return { pending, submitting, decide };
}
