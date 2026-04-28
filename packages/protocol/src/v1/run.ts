import { z } from "zod";
import { Iso8601Schema, type Iso8601 } from "./index";
import type { AgentId } from "./agent";
import type { ConversationId, MessageId, RunId } from "./conversation";
import { AppErrorSchema, type AppError } from "./error";

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "recoverable",
  "succeeded",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  agentId: z.string().min(1),
  status: RunStatusSchema,
  triggeredByMessageId: z.string().min(1),
  resultMessageId: z.string().min(1).nullable(),
  startedAt: Iso8601Schema,
  endedAt: Iso8601Schema.nullable(),
  error: AppErrorSchema.nullable(),
});

export type Run = Omit<
  z.infer<typeof RunSchema>,
  "id" | "conversationId" | "agentId" | "triggeredByMessageId" | "resultMessageId" | "startedAt" | "endedAt" | "error"
> & {
  id: RunId;
  conversationId: ConversationId;
  agentId: AgentId;
  triggeredByMessageId: MessageId;
  resultMessageId: MessageId | null;
  startedAt: Iso8601;
  endedAt: Iso8601 | null;
  error: AppError | null;
};

const baseEvent = z.object({
  runId: z.string().min(1),
  seq: z.number().int().min(0),
  createdAt: Iso8601Schema,
});

export const RunEventSchema = z.discriminatedUnion("type", [
  baseEvent.extend({
    type: z.literal("run.started"),
    agentId: z.string().min(1),
    model: z.string().min(1),
  }),
  baseEvent.extend({
    type: z.literal("text.delta"),
    text: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("tool.planned"),
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: z.unknown(),
  }),
  baseEvent.extend({
    type: z.literal("tool.started"),
    callId: z.string().min(1),
  }),
  baseEvent.extend({
    type: z.literal("tool.completed"),
    callId: z.string().min(1),
    output: z.unknown(),
  }),
  baseEvent.extend({
    type: z.literal("tool.failed"),
    callId: z.string().min(1),
    error: AppErrorSchema,
  }),
  baseEvent.extend({
    type: z.literal("tool.ask"),
    callId: z.string().min(1),
    tool: z.string().min(1),
    reason: z.string().min(1),
    approvalToken: z.string().min(1),
  }),
  baseEvent.extend({
    type: z.literal("run.recoverable"),
    reason: z.enum(["gateway_restarted", "incomplete_tool", "approval_pending"]),
    message: z.string().min(1),
  }),
  baseEvent.extend({
    type: z.literal("run.recovered"),
    mode: z.enum(["auto", "manual"]),
    discardPriorDraft: z.boolean(),
  }),
  baseEvent.extend({
    type: z.literal("tool.retrying"),
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: z.unknown(),
  }),
  baseEvent.extend({
    type: z.literal("run.completed"),
    resultMessageId: z.string().min(1),
    finalText: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("run.failed"),
    error: AppErrorSchema,
  }),
  baseEvent.extend({
    type: z.literal("run.cancelled"),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
