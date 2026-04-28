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

export interface MemoryStatus {
  agentId: string;
  rootPath: string;
  fileCount: number;
  chunkCount: number;
  indexedAt: string | null;
  files: Array<{
    path: string;
    status: "indexed" | "failed";
    indexedAt: string;
    errorMessage: string | null;
  }>;
}

export const memoriesApi = {
  list: async (client: ApiClient, agentId: string) =>
    (await client.get<{ items: Memory[] }>(`/v1/agents/${encodeURIComponent(agentId)}/memories`)).items,
  status: (client: ApiClient, agentId: string) =>
    client.get<MemoryStatus>(`/v1/agents/${encodeURIComponent(agentId)}/memories/status`),
  reindex: (client: ApiClient, agentId: string) =>
    client.post<MemoryStatus>(`/v1/agents/${encodeURIComponent(agentId)}/memories/reindex`, {}),
  create: (client: ApiClient, agentId: string, content: string) =>
    client.post<Memory>(`/v1/agents/${encodeURIComponent(agentId)}/memories`, { content }),
  delete: (client: ApiClient, agentId: string, memoryId: string) =>
    client.delete(`/v1/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId)}`),
};
