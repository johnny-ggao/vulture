import type { ApiClient } from "./client";
import type { MessageDto } from "./conversations";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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
  create: (client: ApiClient, conversationId: string, body: { input: string }) =>
    client.post<CreateRunResponse>(`/v1/conversations/${conversationId}/runs`, body),

  get: (client: ApiClient, runId: string) => client.get<RunDto>(`/v1/runs/${runId}`),

  cancel: (client: ApiClient, runId: string) =>
    client.post<RunDto>(`/v1/runs/${runId}/cancel`, {}),

  approve: (client: ApiClient, runId: string, body: ApprovalRequest) =>
    client.post<void>(`/v1/runs/${runId}/approvals`, body),
};
