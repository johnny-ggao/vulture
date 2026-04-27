export type ApprovalDecision = "allow" | "deny";

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
  abortListener: () => void;
  signal: AbortSignal;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export class ApprovalTimeoutError extends Error {
  readonly code = "tool.approval_timeout";

  constructor(callId: string) {
    super(`approval wait timed out for ${callId}`);
    this.name = "ApprovalTimeoutError";
  }
}

export interface ApprovalWaitOptions {
  timeoutMs?: number;
}

export class ApprovalQueue {
  private readonly pending = new Map<string, PendingEntry>();

  wait(
    callId: string,
    signal: AbortSignal,
    opts: ApprovalWaitOptions = {},
  ): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const entry = this.pending.get(callId);
        if (!entry) return;
        this.pending.delete(callId);
        entry.signal.removeEventListener("abort", entry.abortListener);
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
      };
      const abortListener = () => {
        cleanup();
        reject(new Error(`approval wait aborted for ${callId}`));
      };
      if (signal.aborted) {
        reject(new Error(`approval wait aborted for ${callId}`));
        return;
      }
      signal.addEventListener("abort", abortListener, { once: true });
      const entry: PendingEntry = { resolve, reject, abortListener, signal };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        entry.timeoutId = setTimeout(() => {
          cleanup();
          reject(new ApprovalTimeoutError(callId));
        }, opts.timeoutMs);
      }
      this.pending.set(callId, entry);
    });
  }

  resolve(callId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    this.pending.delete(callId);
    entry.signal.removeEventListener("abort", entry.abortListener);
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    entry.resolve(decision);
    return true;
  }
}
