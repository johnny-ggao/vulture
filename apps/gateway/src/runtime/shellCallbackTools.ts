import { ToolCallError, type ToolCallable } from "@vulture/agent-runtime";
import type { PartialRunEvent } from "../domain/runStore";
import type { ApprovalQueue } from "./approvalQueue";
import type { AppError } from "@vulture/protocol/src/v1/error";

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

    let approvalToken: string | undefined;
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
          | { status: "ask"; callId: string; approvalToken: string; reason: string };

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
        opts.appendEvent(call.runId, {
          type: "tool.ask",
          callId: call.callId,
          tool: call.tool,
          reason: body.reason,
          approvalToken: body.approvalToken,
        });
        const ac = opts.cancelSignals.get(call.runId);
        if (!ac) {
          throw new ToolCallError(
            "tool.execution_failed",
            `no AbortController registered for run ${call.runId}`,
          );
        }
        const decision = await opts.approvalQueue.wait(call.callId, ac.signal);
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
        approvalToken = body.approvalToken;
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
