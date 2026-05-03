import type { ApiClient } from "./client";

export type ConversationPermissionMode = "default" | "read_only" | "auto_review" | "full_access";

export interface ConversationDto {
  id: string;
  agentId: string;
  title: string;
  permissionMode: ConversationPermissionMode;
  /**
   * Per-conversation working directory override. When set, file-touching
   * tools and the @-mention picker resolve paths against this directory
   * instead of the agent's default workspace. `null` means "use the
   * agent's default workspace".
   */
  workingDirectory: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  runId: string | null;
  createdAt: string;
  attachments?: MessageAttachmentDto[];
}

export interface MessageAttachmentDto {
  id: string;
  blobId: string;
  kind: "image" | "file";
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  contentUrl: string;
  createdAt: string;
}

export interface CreateConversationRequest {
  agentId: string;
  title?: string;
  permissionMode?: ConversationPermissionMode;
}

export interface UpdateConversationRequest {
  permissionMode?: ConversationPermissionMode;
  /**
   * Pass an absolute path to set, or `null` to clear and fall back to the
   * agent's default workspace. Omit to leave the current value alone.
   */
  workingDirectory?: string | null;
}

export const conversationsApi = {
  list: async (client: ApiClient, filter?: { agentId?: string }) => {
    const path = filter?.agentId
      ? `/v1/conversations?agentId=${encodeURIComponent(filter.agentId)}`
      : "/v1/conversations";
    return (await client.get<{ items: ConversationDto[] }>(path)).items;
  },

  create: (client: ApiClient, body: CreateConversationRequest) =>
    client.post<ConversationDto>("/v1/conversations", body),

  get: (client: ApiClient, id: string) => client.get<ConversationDto>(`/v1/conversations/${id}`),

  update: (client: ApiClient, id: string, body: UpdateConversationRequest) =>
    client.patch<ConversationDto>(`/v1/conversations/${id}`, body),

  listMessages: async (client: ApiClient, id: string, afterMessageId?: string) => {
    const path = afterMessageId
      ? `/v1/conversations/${id}/messages?afterMessageId=${encodeURIComponent(afterMessageId)}`
      : `/v1/conversations/${id}/messages`;
    return (await client.get<{ items: MessageDto[] }>(path)).items;
  },

  delete: (client: ApiClient, id: string) => client.delete(`/v1/conversations/${id}`),
};
