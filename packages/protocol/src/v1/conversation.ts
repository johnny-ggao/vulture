import { z } from "zod";
import type { BrandedId } from "@vulture/common";
import { Iso8601Schema, type Iso8601 } from "./index";
import type { AgentId } from "./agent";

export type ConversationId = BrandedId<"ConversationId">;
export type MessageId = BrandedId<"MessageId">;
export type RunId = BrandedId<"RunId">;

export const ConversationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string(),
  createdAt: Iso8601Schema,
  updatedAt: Iso8601Schema,
});

export type Conversation = Omit<
  z.infer<typeof ConversationSchema>,
  "id" | "agentId" | "createdAt" | "updatedAt"
> & {
  id: ConversationId;
  agentId: AgentId;
  createdAt: Iso8601;
  updatedAt: Iso8601;
};

export const MessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  runId: z.string().min(1).nullable(),
  createdAt: Iso8601Schema,
});

export type Message = Omit<
  z.infer<typeof MessageSchema>,
  "id" | "conversationId" | "runId" | "createdAt"
> & {
  id: MessageId;
  conversationId: ConversationId;
  runId: RunId | null;
  createdAt: Iso8601;
};

export const CreateConversationRequestSchema = z
  .object({
    agentId: z.string().min(1),
    title: z.string().optional(),
  })
  .strict();
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const PostMessageRequestSchema = z
  .object({ input: z.string().min(1) })
  .strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;
