import type { ApiClient } from "./client";

export type ArtifactKind = "file" | "text" | "link" | "data";

export interface ArtifactEntryDto {
  id: string;
  runId: string;
  conversationId: string;
  agentId: string;
  kind: ArtifactKind;
  title: string;
  mimeType: string | null;
  path: string | null;
  url: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ArtifactsListResponse {
  items: ArtifactEntryDto[];
}

export interface ListArtifactsQuery {
  runId?: string;
  conversationId?: string;
  agentId?: string;
}

export const artifactsApi = {
  list: (client: ApiClient, query: ListArtifactsQuery = {}) => {
    const params = new URLSearchParams();
    if (query.runId) params.set("runId", query.runId);
    if (query.conversationId) params.set("conversationId", query.conversationId);
    if (query.agentId) params.set("agentId", query.agentId);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return client.get<ArtifactsListResponse>(`/v1/artifacts${suffix}`);
  },
};
