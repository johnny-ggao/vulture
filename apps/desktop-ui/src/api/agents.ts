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
  | "memory_search"
  | "memory_get"
  | "memory_append"
  | "browser.snapshot"
  | "browser.click";
export type ReasoningLevel = "low" | "medium" | "high";
export type AgentToolPreset = "none" | "minimal" | "standard" | "developer" | "tl" | "full";

export interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
  skills?: string[];
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
  toolPreset?: AgentToolPreset;
  toolInclude?: AgentToolName[];
  toolExclude?: AgentToolName[];
  skills?: string[] | null;
  workspace?: Pick<Workspace, "id" | "name" | "path">;
  instructions: string;
}

export interface AgentCoreFile {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
}

export interface AgentCoreFilesResponse {
  agentId: string;
  rootPath: string;
  corePath: string;
  files: AgentCoreFile[];
}

export interface AgentCoreFileResponse {
  agentId: string;
  rootPath: string;
  corePath: string;
  file: AgentCoreFile & { content?: string };
}

export const agentsApi = {
  list: async (client: ApiClient) =>
    (await client.get<{ items: Agent[] }>("/v1/agents")).items,
  get: (client: ApiClient, id: string) => client.get<Agent>(`/v1/agents/${id}`),
  save: (client: ApiClient, body: SaveAgentRequest) =>
    client.post<Agent>("/v1/agents", body),
  update: (client: ApiClient, id: string, body: Partial<SaveAgentRequest>) =>
    client.patch<Agent>(`/v1/agents/${id}`, body),
  delete: (client: ApiClient, id: string) => client.delete(`/v1/agents/${id}`),
  listFiles: (client: ApiClient, id: string) =>
    client.get<AgentCoreFilesResponse>(`/v1/agents/${id}/files`),
  getFile: (client: ApiClient, id: string, name: string) =>
    client.get<AgentCoreFileResponse>(`/v1/agents/${id}/files/${encodeURIComponent(name)}`),
  setFile: (client: ApiClient, id: string, name: string, content: string) =>
    client.put<AgentCoreFileResponse>(`/v1/agents/${id}/files/${encodeURIComponent(name)}`, {
      content,
    }),
};
