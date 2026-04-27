export type ApprovalDecision = "allow" | "deny";

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
  abortListener: () => void;
  signal: AbortSignal;
}

export class ApprovalQueue {
  private readonly pending = new Map<string, PendingEntry>();

  wait(callId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        this.pending.delete(callId);
        reject(new Error(`approval wait aborted for ${callId}`));
      };
      if (signal.aborted) {
        reject(new Error(`approval wait aborted for ${callId}`));
        return;
      }
      signal.addEventListener("abort", abortListener, { once: true });
      this.pending.set(callId, { resolve, reject, abortListener, signal });
    });
  }

  resolve(callId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    this.pending.delete(callId);
    entry.signal.removeEventListener("abort", entry.abortListener);
    entry.resolve(decision);
    return true;
  }
}
