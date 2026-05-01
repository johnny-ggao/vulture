import { ToolCallError, type ToolCallable } from "@vulture/agent-runtime";
import type { PartialRunEvent } from "../domain/runStore";
import { ApprovalTimeoutError, type ApprovalQueue } from "./approvalQueue";
import type { AppError } from "@vulture/protocol/src/v1/error";
import type { ConversationPermissionMode } from "@vulture/protocol/src/v1/conversation";
import type { SdkApprovalCallable } from "./openaiLlm";
import {
  defaultAutoApprovalReviewer,
  type AutoApprovalRequest,
  type AutoApprovalReviewer,
  type AutoApprovalReview,
} from "./autoApprovalReviewer";
import { tryEmitRuntimeHook, type RuntimeHookRunner } from "./runtimeHooks";

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface ShellCallbackToolsOpts {
  callbackUrl: string;
  token: string;
  appendEvent: (runId: string, partial: PartialRunEvent) => void;
  approvalQueue: ApprovalQueue;
  cancelSignals: Map<string, AbortController>;
  /** Test injection point. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Test injection point. Defaults to process.pid. */
  callerPid?: number;
  /** Maximum time to wait for user approval before failing the tool call. */
  approvalTimeoutMs?: number;
  /** Optional runtime hooks for emitting approval.required / approval.resolved. */
  runtimeHooks?: RuntimeHookRunner;
  /** Per-run permission mode. full_access skips local ApprovalCard flow. */
  permissionModeForRun?: (runId: string) => ConversationPermissionMode;
  /** Automatic approval reviewer for auto_review mode. */
  autoApprovalReviewer?: AutoApprovalReviewer;
  /**
   * Legacy non-SDK fallback: when true/default, a Rust `ask` response emits
   * tool.ask and blocks until /approvals resolves the in-memory queue.
   *
   * The OpenAI Agents SDK production path should set this to false. Approval is
   * then handled through SDK interruptions and RunState.approve/reject before
   * the shell callback is invoked with an approval token.
   */
  interactiveApprovalFallback?: boolean;
}

export function makeShellCallbackTools(opts: ShellCallbackToolsOpts): ToolCallable {
  const f = opts.fetch ?? fetch;
  const pid = opts.callerPid ?? process.pid;
  return async (call) => {
    // Emit tool.planned upfront so the UI renders a ToolBlock before the
    // shell actually executes (or asks for approval). The block transitions
    // through tool.started / tool.completed | tool.failed below.
    opts.appendEvent(call.runId, {
      type: "tool.planned",
      callId: call.callId,
      tool: call.tool,
      input: call.input,
    });

    let approvalToken: string | undefined = call.approvalToken;
    let started = false;
    const markStarted = () => {
      if (started) return;
      started = true;
      opts.appendEvent(call.runId, {
        type: "tool.started",
        callId: call.callId,
      });
    };

    try {
      while (true) {
        const res = await f(`${opts.callbackUrl}/tools/invoke`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.token}`,
            "Content-Type": "application/json",
            "X-Caller-Pid": String(pid),
          },
          body: JSON.stringify({
            callId: call.callId,
            runId: call.runId,
            tool: call.tool,
            input: call.input,
            workspacePath: call.workspacePath,
            approvalToken,
          }),
        });
        if (!res.ok) {
          markStarted();
          const err: AppError = {
            code: "tool.execution_failed",
            message: `tool callback HTTP ${res.status}`,
          };
          opts.appendEvent(call.runId, {
            type: "tool.failed",
            callId: call.callId,
            error: err,
          });
          throw new ToolCallError(err.code, err.message);
        }
        const body = (await res.json()) as
          | { status: "completed"; callId: string; output: unknown }
          | { status: "failed"; callId: string; error: { code: string; message: string } }
          | { status: "denied"; callId: string; error: { code: string; message: string } }
          | {
              status: "ask";
              callId?: string;
              call_id?: string;
              approvalToken?: string;
              approval_token?: string;
              reason: string;
            };

        if (body.status === "completed") {
          markStarted();
          opts.appendEvent(call.runId, {
            type: "tool.completed",
            callId: call.callId,
            output: body.output,
          });
          return body.output;
        }
        if (body.status === "denied") {
          const err: AppError = {
            code: "tool.permission_denied",
            message: body.error.message,
          };
          opts.appendEvent(call.runId, {
            type: "tool.failed",
            callId: call.callId,
            error: err,
          });
          throw new ToolCallError(err.code, err.message);
        }
        if (body.status === "failed") {
          markStarted();
          const err: AppError = {
            code: "tool.execution_failed",
            message: body.error.message,
          };
          opts.appendEvent(call.runId, {
            type: "tool.failed",
            callId: call.callId,
            error: err,
          });
          throw new ToolCallError(err.code, err.message);
        }
        // status === "ask"
        const nextApprovalToken = body.approvalToken ?? body.approval_token;
        if (!nextApprovalToken) {
          const err: AppError = {
            code: "tool.execution_failed",
            message: "tool callback ask response missing approval token",
          };
          opts.appendEvent(call.runId, {
            type: "tool.failed",
            callId: call.callId,
            error: err,
          });
          throw new ToolCallError(err.code, err.message);
        }
        const permissionMode = opts.permissionModeForRun?.(call.runId);
        if (permissionMode === "full_access") {
          approvalToken = nextApprovalToken;
          markStarted();
          continue;
        }
        const autoDecision = await reviewAutomatically(opts, {
          runId: call.runId,
          callId: call.callId,
          tool: call.tool,
          input: call.input,
          workspacePath: call.workspacePath,
          reason: body.reason,
        });
        if (autoDecision === "allow") {
          approvalToken = nextApprovalToken;
          markStarted();
          continue;
        }
        if (autoDecision === "deny") {
          const err: AppError = {
            code: "tool.permission_denied",
            message: `automatic approval review denied ${call.tool}`,
          };
          opts.appendEvent(call.runId, {
            type: "tool.failed",
            callId: call.callId,
            error: err,
          });
          throw new ToolCallError(err.code, err.message);
        }
        if (opts.interactiveApprovalFallback === false) {
          const err: AppError = {
            code: "tool.execution_failed",
            message:
              "tool approval must be handled by the OpenAI Agents SDK; shell returned ask without an SDK approval token",
          };
          opts.appendEvent(call.runId, {
            type: "tool.failed",
            callId: call.callId,
            error: err,
          });
          throw new ToolCallError(err.code, err.message);
        }
        opts.appendEvent(call.runId, {
          type: "tool.ask",
          callId: call.callId,
          tool: call.tool,
          reason: body.reason,
          approvalToken: nextApprovalToken,
        });
        await tryEmitRuntimeHook(
          opts.runtimeHooks,
          "approval.required",
          {
            runId: call.runId,
            callId: call.callId,
            toolId: call.tool,
            reason: body.reason,
          },
          { runId: call.runId, workspacePath: call.workspacePath },
        );
        const ac = opts.cancelSignals.get(call.runId);
        if (!ac) {
          throw new ToolCallError(
            "tool.execution_failed",
            `no AbortController registered for run ${call.runId}`,
          );
        }
        let decision: "allow" | "deny";
        try {
          decision = await opts.approvalQueue.wait(call.callId, ac.signal, {
            timeoutMs: opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
          });
        } catch (err) {
          if (err instanceof ApprovalTimeoutError) {
            const appError: AppError = {
              code: "tool.approval_timeout",
              message: `approval timed out for ${call.tool}`,
            };
            opts.appendEvent(call.runId, {
              type: "tool.failed",
              callId: call.callId,
              error: appError,
            });
            throw new ToolCallError(appError.code, appError.message);
          }
          throw err;
        }
        await tryEmitRuntimeHook(
          opts.runtimeHooks,
          "approval.resolved",
          {
            runId: call.runId,
            callId: call.callId,
            toolId: call.tool,
            reason: body.reason,
            decision,
          },
          { runId: call.runId, workspacePath: call.workspacePath },
        );
        if (decision === "deny") {
          opts.appendEvent(call.runId, {
            type: "tool.failed",
            callId: call.callId,
            error: {
              code: "tool.permission_denied",
              message: `user denied ${call.tool}`,
            },
          });
          throw new ToolCallError(
            "tool.permission_denied",
            `user denied ${call.tool}`,
          );
        }
        approvalToken = nextApprovalToken;
        markStarted();
        // loop continues — second POST carries token; Rust skips policy
      }
    } catch (err) {
      // Only re-emit tool.failed for unexpected errors (e.g. abort signal),
      // not for the ToolCallError paths above which already emitted.
      if (!(err instanceof ToolCallError)) {
        opts.appendEvent(call.runId, {
          type: "tool.failed",
          callId: call.callId,
          error: {
            code: "tool.execution_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
      throw err;
    }
  };
}

export function makeShellApprovalHandler(opts: ShellCallbackToolsOpts): SdkApprovalCallable {
  return async (request) => {
    if (opts.permissionModeForRun?.(request.runId) === "full_access") {
      return "allow";
    }
    const autoDecision = await reviewAutomatically(opts, request);
    if (autoDecision === "allow") return "allow";
    if (autoDecision === "deny") {
      opts.appendEvent(request.runId, {
        type: "tool.failed",
        callId: request.callId,
        error: {
          code: "tool.permission_denied",
          message: `automatic approval review denied ${request.tool}`,
        },
      });
      return "deny";
    }
    opts.appendEvent(request.runId, {
      type: "tool.ask",
      callId: request.callId,
      tool: request.tool,
      reason: request.reason,
      approvalToken: request.approvalToken,
    });
    await tryEmitRuntimeHook(
      opts.runtimeHooks,
      "approval.required",
      {
        runId: request.runId,
        callId: request.callId,
        toolId: request.tool,
        reason: request.reason,
      },
      { runId: request.runId, workspacePath: request.workspacePath },
    );
    const ac = opts.cancelSignals.get(request.runId);
    if (!ac) {
      throw new ToolCallError(
        "tool.execution_failed",
        `no AbortController registered for run ${request.runId}`,
      );
    }
    try {
      const decision = await opts.approvalQueue.wait(request.callId, ac.signal, {
        timeoutMs: opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      });
      await tryEmitRuntimeHook(
        opts.runtimeHooks,
        "approval.resolved",
        {
          runId: request.runId,
          callId: request.callId,
          toolId: request.tool,
          reason: request.reason,
          decision,
        },
        { runId: request.runId, workspacePath: request.workspacePath },
      );
      if (decision === "deny") {
        opts.appendEvent(request.runId, {
          type: "tool.failed",
          callId: request.callId,
          error: {
            code: "tool.permission_denied",
            message: `user denied ${request.tool}`,
          },
        });
      }
      return decision;
    } catch (err) {
      if (err instanceof ApprovalTimeoutError) {
        const appError: AppError = {
          code: "tool.approval_timeout",
          message: `approval timed out for ${request.tool}`,
        };
        opts.appendEvent(request.runId, {
          type: "tool.failed",
          callId: request.callId,
          error: appError,
        });
        throw new ToolCallError(appError.code, appError.message);
      }
      throw err;
    }
  };
}

async function reviewAutomatically(
  opts: ShellCallbackToolsOpts,
  request: AutoApprovalRequest,
): Promise<"allow" | "deny" | "needs_user" | null> {
  if (opts.permissionModeForRun?.(request.runId) !== "auto_review") return null;
  const reviewer = opts.autoApprovalReviewer ?? defaultAutoApprovalReviewer;
  opts.appendEvent(request.runId, {
    type: "approval.review",
    callId: request.callId,
    tool: request.tool,
    status: "reviewing",
  });
  let review: AutoApprovalReview;
  try {
    review = await reviewer.review(request);
  } catch (cause) {
    const message = `automatic approval review failed closed for ${request.tool}`;
    opts.appendEvent(request.runId, {
      type: "approval.review",
      callId: request.callId,
      tool: request.tool,
      status: "error",
      risk: "critical",
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    opts.appendEvent(request.runId, {
      type: "tool.failed",
      callId: request.callId,
      error: {
        code: "tool.permission_denied",
        message,
      },
    });
    throw new ToolCallError("tool.permission_denied", message);
  }

  const status =
    review.decision === "allow"
      ? "approved"
      : review.decision === "deny"
      ? "denied"
      : "needs_user";
  opts.appendEvent(request.runId, {
    type: "approval.review",
    callId: request.callId,
    tool: request.tool,
    status,
    risk: review.risk,
    reason: review.reason,
  });
  return review.decision;
}
