import type { ApiClient } from "./client";
import type { Workspace } from "./workspaces";

export type AgentToolName =
  | "read"
  | "write"
  | "edit"
  | "apply_patch"
  | "shell.exec"
  | "process"
  | "web_search"
  | "web_fetch"
  | "sessions_list"
  | "sessions_history"
  | "sessions_send"
  | "sessions_spawn"
  | "sessions_yield"
  | "update_plan"
  | "browser.snapshot"
  | "browser.click";
export type ReasoningLevel = "low" | "medium" | "high";

export interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  workspace: Workspace;
  instructions: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveAgentRequest {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  workspace?: Pick<Workspace, "id" | "name" | "path">;
  instructions: string;
}

export const agentsApi = {
  list: async (client: ApiClient) =>
    (await client.get<{ items: Agent[] }>("/v1/agents")).items,
  get: (client: ApiClient, id: string) => client.get<Agent>(`/v1/agents/${id}`),
  save: (client: ApiClient, body: SaveAgentRequest) =>
    client.post<Agent>("/v1/agents", body),
  delete: (client: ApiClient, id: string) => client.delete(`/v1/agents/${id}`),
};
