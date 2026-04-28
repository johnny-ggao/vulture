import type { ApiClient } from "./client";

export interface Memory {
  id: string;
  agentId: string;
  content: string;
  path?: string;
  heading?: string | null;
  startLine?: number;
  endLine?: number;
  source?: "legacy" | "file";
  createdAt: string;
  updatedAt: string;
}

export interface MemorySuggestion {
  id: string;
  agentId: string;
  runId: string | null;
  conversationId: string | null;
  content: string;
  reason: string;
  targetPath: string;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  updatedAt: string;
}

export const memoriesApi = {
  list: async (client: ApiClient, agentId: string) =>
    (await client.get<{ items: Memory[] }>(`/v1/agents/${encodeURIComponent(agentId)}/memories`)).items,
  create: (client: ApiClient, agentId: string, content: string) =>
    client.post<Memory>(`/v1/agents/${encodeURIComponent(agentId)}/memories`, { content }),
  delete: (client: ApiClient, agentId: string, memoryId: string) =>
    client.delete(`/v1/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId)}`),
  listSuggestions: async (client: ApiClient, agentId: string) =>
    (await client.get<{ items: MemorySuggestion[] }>(
      `/v1/agents/${encodeURIComponent(agentId)}/memory-suggestions`,
    )).items,
  acceptSuggestion: (client: ApiClient, agentId: string, suggestionId: string) =>
    client.post<MemorySuggestion>(
      `/v1/agents/${encodeURIComponent(agentId)}/memory-suggestions/${encodeURIComponent(suggestionId)}/accept`,
      {},
    ),
  dismissSuggestion: (client: ApiClient, agentId: string, suggestionId: string) =>
    client.post<MemorySuggestion>(
      `/v1/agents/${encodeURIComponent(agentId)}/memory-suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
      {},
    ),
};
