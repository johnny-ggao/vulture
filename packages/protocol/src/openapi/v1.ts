import { z } from "zod";
import { AgentSchema, SaveAgentRequestSchema } from "../v1/agent";
import { ApprovalRequestSchema } from "../v1/approval";
import {
  ConversationSchema,
  CreateConversationRequestSchema,
  MessageAttachmentSchema,
  MessageSchema,
  PostMessageRequestSchema,
} from "../v1/conversation";
import { AppErrorSchema } from "../v1/error";
import { ProfileSchema, UpdateProfileRequestSchema } from "../v1/profile";
import { RunEventSchema, RunSchema } from "../v1/run";
import { SaveWorkspaceRequestSchema, WorkspaceSchema } from "../v1/workspace";

type JsonObject = Record<string, unknown>;

const REF_PREFIX = "#/components/schemas/";

export function buildOpenApiV1(): JsonObject {
  return {
    openapi: "3.1.0",
    info: {
      title: "Vulture Gateway API",
      version: "v1",
    },
    servers: [{ url: "http://127.0.0.1:{port}", variables: { port: { default: "4099" } } }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/profile": {
        get: operation({
          operationId: "getProfile",
          tags: ["profile"],
          responses: { 200: jsonResponse("Profile") },
        }),
        patch: operation({
          operationId: "updateProfile",
          tags: ["profile"],
          requestBody: jsonRequest("UpdateProfileRequest"),
          responses: { 200: jsonResponse("Profile") },
        }),
      },
      "/v1/workspaces": {
        get: operation({
          operationId: "listWorkspaces",
          tags: ["workspaces"],
          responses: { 200: jsonResponse("WorkspaceList") },
        }),
        post: operation({
          operationId: "saveWorkspace",
          tags: ["workspaces"],
          parameters: [idempotencyHeader()],
          requestBody: jsonRequest("SaveWorkspaceRequest"),
          responses: {
            201: jsonResponse("Workspace"),
            422: errorResponse(),
          },
        }),
      },
      "/v1/workspaces/{id}": {
        delete: operation({
          operationId: "deleteWorkspace",
          tags: ["workspaces"],
          parameters: [pathParam("id")],
          responses: { 204: emptyResponse() },
        }),
      },
      "/v1/agents": {
        get: operation({
          operationId: "listAgents",
          tags: ["agents"],
          responses: { 200: jsonResponse("AgentList") },
        }),
        post: operation({
          operationId: "saveAgent",
          tags: ["agents"],
          parameters: [idempotencyHeader()],
          requestBody: jsonRequest("SaveAgentRequest"),
          responses: { 201: jsonResponse("Agent") },
        }),
      },
      "/v1/agents/{id}": {
        get: operation({
          operationId: "getAgent",
          tags: ["agents"],
          parameters: [pathParam("id")],
          responses: {
            200: jsonResponse("Agent"),
            404: errorResponse(),
          },
        }),
        patch: operation({
          operationId: "updateAgent",
          tags: ["agents"],
          parameters: [pathParam("id")],
          requestBody: jsonRequest("SaveAgentRequest"),
          responses: {
            200: jsonResponse("Agent"),
            404: errorResponse(),
          },
        }),
        delete: operation({
          operationId: "deleteAgent",
          tags: ["agents"],
          parameters: [pathParam("id")],
          responses: {
            204: emptyResponse(),
            409: errorResponse(),
          },
        }),
      },
      "/v1/conversations": {
        get: operation({
          operationId: "listConversations",
          tags: ["conversations"],
          parameters: [queryParam("agentId", false)],
          responses: { 200: jsonResponse("ConversationList") },
        }),
        post: operation({
          operationId: "createConversation",
          tags: ["conversations"],
          parameters: [idempotencyHeader()],
          requestBody: jsonRequest("CreateConversationRequest"),
          responses: { 201: jsonResponse("Conversation") },
        }),
      },
      "/v1/conversations/{id}": {
        get: operation({
          operationId: "getConversation",
          tags: ["conversations"],
          parameters: [pathParam("id")],
          responses: {
            200: jsonResponse("Conversation"),
            404: errorResponse(),
          },
        }),
        delete: operation({
          operationId: "deleteConversation",
          tags: ["conversations"],
          parameters: [pathParam("id")],
          responses: { 204: emptyResponse() },
        }),
      },
      "/v1/conversations/{id}/messages": {
        get: operation({
          operationId: "listConversationMessages",
          tags: ["conversations"],
          parameters: [pathParam("id"), queryParam("afterMessageId", false)],
          responses: {
            200: jsonResponse("MessageList"),
            404: errorResponse(),
          },
        }),
      },
      "/v1/attachments": {
        post: operation({
          operationId: "uploadAttachment",
          tags: ["attachments"],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: { file: { type: "string", format: "binary" } },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            201: jsonResponse("MessageAttachment"),
            400: errorResponse(),
            413: errorResponse(),
          },
        }),
      },
      "/v1/attachments/{id}/content": {
        get: operation({
          operationId: "getAttachmentContent",
          tags: ["attachments"],
          parameters: [pathParam("id")],
          responses: {
            200: {
              description: "Attachment bytes",
              content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
            },
            404: errorResponse(),
          },
        }),
      },
      "/v1/conversations/{cid}/runs": {
        get: operation({
          operationId: "listConversationRuns",
          tags: ["runs"],
          parameters: [
            pathParam("cid"),
            {
              name: "status",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["queued", "running", "recoverable", "succeeded", "failed", "cancelled", "active"],
              },
            },
          ],
          responses: {
            200: jsonResponse("RunList"),
            404: errorResponse(),
          },
        }),
        post: operation({
          operationId: "createConversationRun",
          tags: ["runs"],
          parameters: [pathParam("cid"), idempotencyHeader()],
          requestBody: jsonRequest("PostMessageRequest"),
          responses: {
            202: jsonResponse("CreateRunResponse"),
            404: errorResponse(),
            409: errorResponse(),
          },
        }),
      },
      "/v1/runs/{rid}": {
        get: operation({
          operationId: "getRun",
          tags: ["runs"],
          parameters: [pathParam("rid")],
          responses: {
            200: jsonResponse("Run"),
            404: errorResponse(),
          },
        }),
      },
      "/v1/runs/{rid}/events": {
        get: operation({
          operationId: "streamRunEvents",
          tags: ["runs"],
          parameters: [
            pathParam("rid"),
            {
              name: "Last-Event-ID",
              in: "header",
              required: false,
              schema: { type: "integer", minimum: 0 },
            },
          ],
          responses: {
            200: {
              description: "Server-sent run events",
              content: {
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            404: errorResponse(),
          },
        }),
      },
      "/v1/runs/{rid}/cancel": runAction("cancelRun", "Run"),
      "/v1/runs/{rid}/resume": runAction("resumeRun", "Run"),
      "/v1/runs/{rid}/approvals": {
        post: operation({
          operationId: "decideRunApproval",
          tags: ["runs"],
          parameters: [pathParam("rid")],
          requestBody: jsonRequest("ApprovalRequest"),
          responses: {
            202: emptyResponse(),
            400: errorResponse(),
            404: errorResponse(),
          },
        }),
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Agent: schema(AgentSchema),
        AgentList: listSchema("Agent"),
        SaveAgentRequest: schema(SaveAgentRequestSchema),
        ApprovalRequest: schema(ApprovalRequestSchema),
        AppError: schema(AppErrorSchema),
        Conversation: schema(ConversationSchema),
        ConversationList: listSchema("Conversation"),
        CreateConversationRequest: schema(CreateConversationRequestSchema),
        Message: schema(MessageSchema),
        MessageAttachment: schema(MessageAttachmentSchema),
        MessageList: listSchema("Message"),
        PostMessageRequest: schema(PostMessageRequestSchema),
        Profile: schema(ProfileSchema),
        UpdateProfileRequest: schema(UpdateProfileRequestSchema),
        Run: schema(RunSchema),
        RunEvent: schema(RunEventSchema),
        RunList: listSchema("Run"),
        CreateRunResponse: {
          type: "object",
          required: ["run", "message", "eventStreamUrl"],
          additionalProperties: false,
          properties: {
            run: ref("Run"),
            message: ref("Message"),
            eventStreamUrl: { type: "string", minLength: 1 },
          },
        },
        Workspace: schema(WorkspaceSchema),
        WorkspaceList: listSchema("Workspace"),
        SaveWorkspaceRequest: schema(SaveWorkspaceRequestSchema),
      },
    },
  };
}

function schema(value: z.ZodType): JsonObject {
  return stripJsonSchemaDialect(z.toJSONSchema(value)) as JsonObject;
}

function stripJsonSchemaDialect(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripJsonSchemaDialect);
  if (!value || typeof value !== "object") return value;
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if (key === "$schema") continue;
    output[key] = stripJsonSchemaDialect(child);
  }
  return output;
}

function ref(name: string): JsonObject {
  return { $ref: `${REF_PREFIX}${name}` };
}

function listSchema(itemName: string): JsonObject {
  return {
    type: "object",
    required: ["items"],
    additionalProperties: false,
    properties: { items: { type: "array", items: ref(itemName) } },
  };
}

function jsonRequest(schemaName: string): JsonObject {
  return {
    required: true,
    content: { "application/json": { schema: ref(schemaName) } },
  };
}

function jsonResponse(schemaName: string): JsonObject {
  return {
    description: "OK",
    content: { "application/json": { schema: ref(schemaName) } },
  };
}

function errorResponse(): JsonObject {
  return {
    description: "Error",
    content: { "application/json": { schema: ref("AppError") } },
  };
}

function emptyResponse(): JsonObject {
  return { description: "No content" };
}

function operation(input: {
  operationId: string;
  tags: string[];
  parameters?: JsonObject[];
  requestBody?: JsonObject;
  responses: Record<number, JsonObject>;
}): JsonObject {
  return {
    operationId: input.operationId,
    tags: input.tags,
    ...(input.parameters ? { parameters: input.parameters } : {}),
    ...(input.requestBody ? { requestBody: input.requestBody } : {}),
    responses: Object.fromEntries(
      Object.entries(input.responses).map(([status, response]) => [status, response]),
    ),
  };
}

function pathParam(name: string): JsonObject {
  return { name, in: "path", required: true, schema: { type: "string", minLength: 1 } };
}

function queryParam(name: string, required: boolean): JsonObject {
  return { name, in: "query", required, schema: { type: "string", minLength: 1 } };
}

function idempotencyHeader(): JsonObject {
  return {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
}

function runAction(operationId: string, responseSchema: string): JsonObject {
  return {
    post: operation({
      operationId,
      tags: ["runs"],
      parameters: [pathParam("rid")],
      responses: {
        202: jsonResponse(responseSchema),
        404: errorResponse(),
        409: errorResponse(),
      },
    }),
  };
}
