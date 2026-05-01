import { z } from "zod";
import type { BrandedId } from "@vulture/common";
import { Iso8601Schema, type Iso8601 } from "./index";
import type { AgentId } from "./agent";

export type ConversationId = BrandedId<"ConversationId">;
export type MessageId = BrandedId<"MessageId">;
export type RunId = BrandedId<"RunId">;

export const ConversationPermissionModeSchema = z.enum(["default", "read_only", "full_access"]);
export type ConversationPermissionMode = z.infer<typeof ConversationPermissionModeSchema>;

const ConversationPermissionModeInputSchema = z.preprocess(
  (value) => (value === "policy" ? "default" : value),
  ConversationPermissionModeSchema,
);

export const ConversationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string(),
  permissionMode: ConversationPermissionModeSchema,
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

export const AttachmentKindSchema = z.enum(["image", "file"]);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const MessageAttachmentSchema = z.object({
  id: z.string().min(1),
  blobId: z.string().min(1),
  kind: AttachmentKindSchema,
  displayName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  contentUrl: z.string().min(1),
  createdAt: Iso8601Schema,
});

export type MessageAttachment = Omit<
  z.infer<typeof MessageAttachmentSchema>,
  "createdAt"
> & {
  createdAt: Iso8601;
};

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  runId: z.string().min(1).nullable(),
  createdAt: Iso8601Schema,
  attachments: z.array(MessageAttachmentSchema).default([]),
});

export type Message = Omit<
  z.infer<typeof MessageSchema>,
  "id" | "conversationId" | "runId" | "createdAt"
> & {
  id: MessageId;
  conversationId: ConversationId;
  runId: RunId | null;
  createdAt: Iso8601;
  attachments: MessageAttachment[];
};

export const CreateConversationRequestSchema = z
  .object({
    agentId: z.string().min(1),
    title: z.string().optional(),
    permissionMode: ConversationPermissionModeInputSchema.default("default"),
  })
  .strict();
export type CreateConversationRequest = {
  agentId: string;
  title?: string;
  permissionMode?: ConversationPermissionMode;
};

export const UpdateConversationRequestSchema = z
  .object({
    permissionMode: ConversationPermissionModeInputSchema.optional(),
  })
  .strict()
  .refine((value) => value.permissionMode !== undefined, {
    message: "at least one field is required",
  });
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequestSchema>;

export const PostMessageRequestSchema = z
  .object({
    input: z.string().min(1),
    attachmentIds: z.array(z.string().min(1)).max(10).optional(),
  })
  .strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;
