import type { ToolCallable, LlmCheckpoint } from "@vulture/agent-runtime";
import type { ConversationPermissionMode } from "@vulture/protocol/src/v1/conversation";
import type { RuntimeHookRunner } from "../runtime/runtimeHooks";
import type { z } from "zod";

export type GatewayToolRisk = "safe" | "approval" | "dangerous";
export type GatewayToolSource = "core" | "plugin" | "mcp";
export type GatewayToolCategory =
  | "runtime"
  | "browser"
  | "fs"
  | "workspace"
  | "web"
  | "sessions"
  | "memory"
  | "agents";

export interface GatewayToolRunContext {
  runId: string;
  workspacePath: string;
  toolCallable: ToolCallable;
  sdkApprovedToolCalls: Map<string, string>;
  permissionMode?: ConversationPermissionMode;
  onCheckpoint?: (checkpoint: LlmCheckpoint) => void;
  runtimeHooks?: RuntimeHookRunner;
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
  /** True only when replaying the same call after an unknown interruption is safe. */
  idempotent: boolean;
  needsApproval: (
    ctx: GatewayToolApprovalContext,
    input: unknown,
  ) => GatewayToolApprovalDecision | Promise<GatewayToolApprovalDecision>;
  execute: (ctx: GatewayToolExecutionContext, input: unknown) => Promise<unknown>;
}
