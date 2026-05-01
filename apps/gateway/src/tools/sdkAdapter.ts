import { tool, type Tool } from "@openai/agents";
import { ToolCallError } from "@vulture/agent-runtime";
import type { ConversationPermissionMode } from "@vulture/protocol/src/v1/conversation";
import type { GatewayToolRunContext, GatewayToolSpec } from "./types";
import { coreToolApprovalDecision } from "./coreTools";

export type { GatewayToolRunContext };

export function toSdkTool(spec: GatewayToolSpec): Tool<GatewayToolRunContext> {
  return tool({
    name: spec.sdkName,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (input, context, details) => {
      const ctx = context?.context as GatewayToolRunContext | undefined;
      if (!ctx) throw new Error("makeOpenAILlm: missing SdkRunContext");
      const callId = details?.toolCall?.callId ?? `c-${crypto.randomUUID()}`;
      return await executeToolWithCheckpoint(spec, ctx, callId, input);
    },
    needsApproval: async (context, input) => {
      const ctx = context.context as GatewayToolRunContext | undefined;
      if (!ctx) return true;
      if (ctx.permissionMode === "full_access") return false;
      return (await spec.needsApproval(ctx, input)).needsApproval;
    },
  });
}

export function sdkApprovalDecision(
  toolName: string,
  input: unknown,
  workspacePath: string | undefined,
  permissionMode?: ConversationPermissionMode,
): { needsApproval: boolean; reason?: string } {
  return coreToolApprovalDecision(toolName, input, workspacePath, permissionMode);
}

async function executeToolWithCheckpoint(
  spec: GatewayToolSpec,
  ctx: GatewayToolRunContext,
  callId: string,
  input: unknown,
): Promise<unknown> {
  const approvalToken =
    ctx.sdkApprovedToolCalls?.get(callId) ??
    (ctx.permissionMode === "full_access" ? "full-access" : undefined);
  const before = await ctx.runtimeHooks?.runToolBeforeCall(
    {
      runId: ctx.runId,
      workspacePath: ctx.workspacePath,
      callId,
      toolId: spec.id,
      category: spec.category,
      idempotent: spec.idempotent,
      input,
    },
    {
      runId: ctx.runId,
      workspacePath: ctx.workspacePath,
    },
  );
  // Trust the runner's decision: runToolBeforeCall already applied each hook's
  // patch in priority order using hasOwnProperty semantics. A `??` fallback
  // here would silently restore the original input when a hook deliberately
  // cleared it to null/undefined.
  const effectiveInput = before ? before.input : input;
  if (before?.blocked) {
    await ctx.runtimeHooks?.emit("tool.afterCall", {
      runId: ctx.runId,
      workspacePath: ctx.workspacePath,
      callId,
      toolId: spec.id,
      category: spec.category,
      idempotent: spec.idempotent,
      input: effectiveInput,
      outcome: "blocked",
      durationMs: 0,
      error: before.reason,
    });
    throw new ToolCallError("tool.permission_denied", before.reason ?? "tool blocked");
  }
  ctx.onCheckpoint?.({
    sdkState: null,
    activeTool: {
      callId,
      tool: spec.id,
      input: effectiveInput,
      approvalToken,
      idempotent: spec.idempotent,
    },
  });
  const startedAt = Date.now();
  try {
    const output = await spec.execute(
      {
        ...ctx,
        callId,
        approvalToken,
      },
      effectiveInput,
    );
    await ctx.runtimeHooks?.emit("tool.afterCall", {
      runId: ctx.runId,
      workspacePath: ctx.workspacePath,
      callId,
      toolId: spec.id,
      category: spec.category,
      idempotent: spec.idempotent,
      input: effectiveInput,
      outcome: "completed",
      durationMs: Date.now() - startedAt,
      output,
    });
    return output;
  } catch (err) {
    await ctx.runtimeHooks?.emit("tool.afterCall", {
      runId: ctx.runId,
      workspacePath: ctx.workspacePath,
      callId,
      toolId: spec.id,
      category: spec.category,
      idempotent: spec.idempotent,
      input: effectiveInput,
      outcome: "error",
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    ctx.onCheckpoint?.({ sdkState: null, activeTool: null });
  }
}
