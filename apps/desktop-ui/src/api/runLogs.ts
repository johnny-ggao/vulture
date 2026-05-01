import type { ApiClient } from "./client";
import type { MessageDto } from "./conversations";
import type { RunDto, RunStatus } from "./runs";
import type { SubagentSessionDto } from "./subagentSessions";

export type RunLogStatusFilter = RunStatus | "active";

export interface RunLogSummaryDto {
  run: RunDto;
  conversationTitle: string | null;
  model: string | null;
  eventCount: number;
  toolCallCount: number;
  approvalCount: number;
  artifactCount: number;
  subagentCount: number;
}

export interface RunLogsListResponse {
  items: RunLogSummaryDto[];
  nextOffset: number | null;
}

export interface RunTraceEventDto {
  type: string;
  runId: string;
  seq: number;
  createdAt: string;
  [key: string]: unknown;
}

export interface RunTraceArtifactDto {
  id: string;
  runId: string;
  conversationId: string;
  agentId: string;
  kind: "file" | "text" | "link" | "data";
  title: string;
  mimeType: string | null;
  path: string | null;
  url: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RunTraceResponse {
  run: RunDto;
  messages: MessageDto[];
  events: RunTraceEventDto[];
  recovery: unknown;
  subagentSessions: SubagentSessionDto[];
  artifacts: RunTraceArtifactDto[];
}

export interface ListRunLogsQuery {
  status?: RunLogStatusFilter;
  agentId?: string;
  limit?: number;
  offset?: number;
}

export const runLogsApi = {
  list: async (client: ApiClient, query: ListRunLogsQuery = {}) => {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.agentId) params.set("agentId", query.agentId);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.offset) params.set("offset", String(query.offset));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return client.get<RunLogsListResponse>(`/v1/run-logs${suffix}`);
  },

  trace: (client: ApiClient, runId: string) =>
    client.get<RunTraceResponse>(`/v1/runs/${encodeURIComponent(runId)}/trace`),
};
