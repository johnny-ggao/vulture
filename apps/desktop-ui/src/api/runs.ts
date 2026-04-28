import type { ApiClient } from "./client";
import type { MessageDto } from "./conversations";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "recoverable";

export interface RunDto {
  id: string;
  conversationId: string;
  agentId: string;
  status: RunStatus;
  triggeredByMessageId: string;
  resultMessageId: string | null;
  startedAt: string;
  endedAt: string | null;
  error: { code: string; message: string } | null;
  usage: TokenUsageDto | null;
}

export interface TokenUsageDto {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CreateRunResponse {
  run: RunDto;
  message: MessageDto;
  eventStreamUrl: string;
}

export type ApprovalDecision = "allow" | "deny";

export interface ApprovalRequest {
  callId: string;
  decision: ApprovalDecision;
}

export const runsApi = {
  create: (
    client: ApiClient,
    conversationId: string,
    body: { input: string; attachmentIds?: string[] },
  ) =>
    client.post<CreateRunResponse>(`/v1/conversations/${conversationId}/runs`, body),

  get: (client: ApiClient, runId: string) => client.get<RunDto>(`/v1/runs/${runId}`),

  listForConversation: async (
    client: ApiClient,
    conversationId: string,
    filter: { status?: RunStatus | "active" } = {},
  ) => {
    const query = filter.status ? `?status=${encodeURIComponent(filter.status)}` : "";
    return (
      await client.get<{ items: RunDto[] }>(`/v1/conversations/${conversationId}/runs${query}`)
    ).items;
  },

  cancel: (client: ApiClient, runId: string) =>
    client.post<RunDto>(`/v1/runs/${runId}/cancel`, {}),

  resume: (client: ApiClient, runId: string) =>
    client.post<RunDto>(`/v1/runs/${runId}/resume`, {}),

  approve: (client: ApiClient, runId: string, body: ApprovalRequest) =>
    client.post<void>(`/v1/runs/${runId}/approvals`, body),
};
