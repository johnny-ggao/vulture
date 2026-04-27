import { ToolCallError, type ToolCallable } from "@vulture/agent-runtime";
import type { PartialRunEvent } from "../domain/runStore";
import type { ApprovalQueue } from "./approvalQueue";

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
    let approvalToken: string | undefined;
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
        throw new ToolCallError(
          "tool.execution_failed",
          `tool callback HTTP ${res.status}`,
        );
      }
      const body = (await res.json()) as
        | { status: "completed"; callId: string; output: unknown }
        | { status: "failed"; callId: string; error: { code: string; message: string } }
        | { status: "denied"; callId: string; error: { code: string; message: string } }
        | { status: "ask"; callId: string; approvalToken: string; reason: string };

      if (body.status === "completed") return body.output;
      if (body.status === "denied") {
        throw new ToolCallError(
          body.error.code ?? "tool.permission_denied",
          body.error.message,
        );
      }
      if (body.status === "failed") {
        throw new ToolCallError(
          body.error.code ?? "tool.execution_failed",
          body.error.message,
        );
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
        throw new ToolCallError(
          "tool.permission_denied",
          `user denied ${call.tool}`,
        );
      }
      approvalToken = body.approvalToken;
      // loop continues — second POST carries token; Rust skips policy
    }
  };
}
