import type { ApiClient } from "./client";

export interface Memory {
  id: string;
  agentId: string;
  content: string;
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
};
