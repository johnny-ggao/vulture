import { z } from "zod";

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

export const RunCreateParams = z.object({
  profileId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.string().min(1),
});

export const ToolName = z.enum([
  "file.read",
  "file.write",
  "shell.exec",
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
