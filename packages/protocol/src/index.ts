import { z } from "zod";
export {
  OPENAPI_V1_ENDPOINTS,
  OPENAPI_V1_ENDPOINTS_BY_OPERATION_ID,
  buildOpenApiV1,
  buildOpenApiV1Path,
  getOpenApiV1Endpoint,
  type OpenApiV1Endpoint,
  type OpenApiV1EndpointByOperationId,
  type OpenApiV1Method,
  type OpenApiV1OperationId,
  type OpenApiV1Path,
  type OpenApiV1PathParamNames,
  type OpenApiV1PathParams,
} from "./openapi";

export type JsonPrimitive = string | number | boolean | null;
export type Json = JsonPrimitive | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

export const JsonRpcId = z.union([z.string(), z.number()]);

export const JsonRpcRequest = z.object({
  id: JsonRpcId.optional(),
  method: z.string().min(1),
  params: z.record(z.string(), JsonValue).optional(),
});

export const JsonRpcSuccess = z.object({
  id: JsonRpcId,
  result: JsonValue,
});

export const JsonRpcError = z.object({
  id: JsonRpcId.optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean().default(false),
    details: z.record(z.string(), JsonValue).optional(),
  }),
});

export const AgentToolName = z.enum([
  "read",
  "write",
  "edit",
  "apply_patch",
  "shell.exec",
  "process",
  "web_search",
  "web_fetch",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "update_plan",
  "browser.snapshot",
  "browser.click",
]);

export const AgentRunConfig = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(AgentToolName).default([]),
});

export const WorkspaceRunConfig = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
});

export const RunCreateParams = z.object({
  profileId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.string().min(1),
  agent: AgentRunConfig.optional(),
  workspace: WorkspaceRunConfig.optional(),
});

export const ToolName = z.enum([
  "read",
  "write",
  "edit",
  "apply_patch",
  "file.read",
  "file.write",
  "shell.exec",
  "process",
  "web_search",
  "web_fetch",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "update_plan",
  "terminal.pty",
  "browser.open",
  "browser.attach",
  "browser.snapshot",
  "browser.click",
  "browser.input",
  "browser.scroll",
  "browser.keypress",
  "browser.extract",
  "browser.close_agent_tabs",
  "browser.forward_cdp_limited",
  "mcp.invoke",
]);

export const ToolRequestParams = z.object({
  runId: z.string().min(1),
  tool: ToolName.or(z.string().regex(/^git\.[A-Za-z0-9._-]+$/)),
  input: z.record(z.string(), JsonValue),
});

export const RunEventType = z.enum([
  "run_started",
  "model_delta",
  "tool_requested",
  "tool_result",
  "approval_required",
  "run_completed",
  "run_failed",
]);

export type RunEventTypeName = z.infer<typeof RunEventType>;

export type RunEvent<TPayload extends JsonObject = JsonObject> = {
  runId: string;
  type: RunEventTypeName;
  payload: TPayload;
  createdAt: string;
};

export function makeEvent<TPayload extends JsonObject>(
  runId: string,
  type: RunEventTypeName,
  payload: TPayload,
): RunEvent<TPayload> {
  return {
    runId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}
