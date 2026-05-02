import type { ApiClient } from "./client";
import type { MessageDto } from "./conversations";

export type SubagentSessionStatus = "active" | "completed" | "failed" | "cancelled";

export interface SubagentSessionDto {
  id: string;
  parentConversationId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  label: string;
  title: string | null;
  task: string | null;
  status: SubagentSessionStatus;
  messageCount: number;
  resultSummary: string | null;
  resultMessageId: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListSubagentSessionsFilter {
  parentConversationId?: string;
  parentRunId?: string;
  agentId?: string;
  limit?: number;
}

export interface SubagentSessionMessagesResponse {
  session: SubagentSessionDto;
  items: MessageDto[];
}

export const subagentSessionsApi = {
  list: async (client: ApiClient, filter: ListSubagentSessionsFilter = {}) => {
    const query = queryString({
      parentConversationId: filter.parentConversationId,
      parentRunId: filter.parentRunId,
      agentId: filter.agentId,
      limit: filter.limit,
    });
    return (await client.get<{ items: SubagentSessionDto[] }>(
      `/v1/subagent-sessions${query}`,
    )).items;
  },

  messages: (client: ApiClient, sessionId: string, limit = 50) =>
    client.get<SubagentSessionMessagesResponse>(
      `/v1/subagent-sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    ),
};

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
