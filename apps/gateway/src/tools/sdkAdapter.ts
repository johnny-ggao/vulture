import { tool, type Tool } from "@openai/agents";
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
      return (await spec.needsApproval(ctx, input)).needsApproval;
    },
  });
}

export function sdkApprovalDecision(
  toolName: string,
  input: unknown,
  workspacePath: string | undefined,
): { needsApproval: boolean; reason?: string } {
  return coreToolApprovalDecision(toolName, input, workspacePath);
}

async function executeToolWithCheckpoint(
  spec: GatewayToolSpec,
  ctx: GatewayToolRunContext,
  callId: string,
  input: unknown,
): Promise<unknown> {
  const approvalToken = ctx.sdkApprovedToolCalls?.get(callId);
  ctx.onCheckpoint?.({
    sdkState: null,
    activeTool: {
      callId,
      tool: spec.id,
      input,
      approvalToken,
    },
  });
  try {
    return await spec.execute(
      {
        ...ctx,
        callId,
        approvalToken,
      },
      input,
    );
  } finally {
    ctx.onCheckpoint?.({ sdkState: null, activeTool: null });
  }
}
