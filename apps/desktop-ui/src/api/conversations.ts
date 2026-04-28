import type { ApiClient } from "./client";

export interface ConversationDto {
  id: string;
  agentId: string;
  title: string;
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

  listMessages: async (client: ApiClient, id: string, afterMessageId?: string) => {
    const path = afterMessageId
      ? `/v1/conversations/${id}/messages?afterMessageId=${encodeURIComponent(afterMessageId)}`
      : `/v1/conversations/${id}/messages`;
    return (await client.get<{ items: MessageDto[] }>(path)).items;
  },

  delete: (client: ApiClient, id: string) => client.delete(`/v1/conversations/${id}`),
};
