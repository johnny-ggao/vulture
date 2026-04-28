import type { ToolCallable, LlmCheckpoint } from "@vulture/agent-runtime";
import type { z } from "zod";

export type GatewayToolRisk = "safe" | "approval" | "dangerous";
export type GatewayToolSource = "core" | "plugin" | "mcp";
export type GatewayToolCategory = "runtime" | "browser" | "fs" | "workspace";

export interface GatewayToolRunContext {
  runId: string;
  workspacePath: string;
  toolCallable: ToolCallable;
  sdkApprovedToolCalls: Map<string, string>;
  onCheckpoint?: (checkpoint: LlmCheckpoint) => void;
}

export interface GatewayToolExecutionContext extends GatewayToolRunContext {
  callId: string;
  approvalToken?: string;
}

export interface GatewayToolApprovalContext extends GatewayToolRunContext {}

export interface GatewayToolApprovalDecision {
  needsApproval: boolean;
  reason?: string;
}

export interface GatewayToolSpec {
  id: string;
  sdkName: string;
  label: string;
  description: string;
  parameters: z.ZodObject;
  source: GatewayToolSource;
  category: GatewayToolCategory;
  risk: GatewayToolRisk;
  needsApproval: (
    ctx: GatewayToolApprovalContext,
    input: unknown,
  ) => GatewayToolApprovalDecision | Promise<GatewayToolApprovalDecision>;
  execute: (ctx: GatewayToolExecutionContext, input: unknown) => Promise<unknown>;
}
