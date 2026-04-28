import type { AppError } from "@vulture/protocol/src/v1/error";
import type { ActiveToolRecovery, RunStore } from "../domain/runStore";

export interface RecoveryCandidate {
  runId: string;
  hasRecoveryState: boolean;
  sdkState: string | null;
  activeTool: ActiveToolRecovery | null;
  activeToolHasTerminalEvent: boolean;
  hasApprovalInterruption: boolean;
}

export type RecoveryDecision =
  | { kind: "fail"; error: AppError }
  | { kind: "recoverable"; reason: "incomplete_tool" | "approval_pending"; message: string }
  | { kind: "auto_resume" };

export function classifyInflightRun(candidate: RecoveryCandidate): RecoveryDecision {
  if (!candidate.hasRecoveryState || !candidate.sdkState) {
    const error: AppError = {
      code: "internal.recovery_state_unavailable",
      message: `recovery state unavailable for ${candidate.runId}`,
    };
    return { kind: "fail", error };
  }

  if (candidate.activeTool && !candidate.activeToolHasTerminalEvent) {
    return {
      kind: "recoverable",
      reason: "incomplete_tool",
      message: `Tool ${candidate.activeTool.tool} may have been interrupted before completion.`,
    };
  }

  if (candidate.hasApprovalInterruption) {
    return {
      kind: "recoverable",
      reason: "approval_pending",
      message: "Run is waiting for approval.",
    };
  }

  return { kind: "auto_resume" };
}

export async function recoverInflightRuns(deps: {
  runs: RunStore;
  hasApprovalInterruption?: (sdkState: string, runId: string) => Promise<boolean>;
}): Promise<Array<{ kind: "auto_resume"; runId: string }>> {
  const actions: Array<{ kind: "auto_resume"; runId: string }> = [];
  for (const run of deps.runs.listInflight()) {
    const state = deps.runs.getRecoveryState(run.id);
    const activeToolHasTerminalEvent = state?.activeTool
      ? deps.runs.hasTerminalToolEvent(run.id, state.activeTool.callId)
      : false;
    const activeToolTakesPrecedence = Boolean(state?.activeTool && !activeToolHasTerminalEvent);
    const hasApprovalInterruption =
      state?.sdkState && deps.hasApprovalInterruption && !activeToolTakesPrecedence
        ? await deps.hasApprovalInterruption(state.sdkState, run.id)
        : false;
    const decision = classifyInflightRun({
      runId: run.id,
      hasRecoveryState: Boolean(state),
      sdkState: state?.sdkState ?? null,
      activeTool: state?.activeTool ?? null,
      activeToolHasTerminalEvent,
      hasApprovalInterruption,
    });

    if (decision.kind === "fail") {
      deps.runs.markFailed(run.id, decision.error);
      continue;
    }

    if (decision.kind === "recoverable") {
      deps.runs.markRecoverable(run.id);
      deps.runs.appendEvent(run.id, {
        type: "run.recoverable",
        reason: decision.reason,
        message: decision.message,
      });
      continue;
    }

    deps.runs.markRecoverable(run.id);
    actions.push({ kind: "auto_resume", runId: run.id });
  }
  return actions;
}
