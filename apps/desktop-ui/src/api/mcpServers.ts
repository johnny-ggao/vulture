import type { ApiClient } from "./client";

export type McpTrust = "trusted" | "ask" | "disabled";

export interface McpRuntimeStatus {
  status: "connected" | "disconnected" | "failed";
  lastError: string | null;
  toolCount: number;
  updatedAt: string | null;
}

export interface McpServer {
  id: string;
  profileId: string;
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  trust: McpTrust;
  enabled: boolean;
  enabledTools: string[] | null;
  disabledTools: string[];
  createdAt: string;
  updatedAt: string;
  runtime: McpRuntimeStatus;
}

export interface SaveMcpServer {
  id: string;
  name: string;
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  trust?: McpTrust;
  enabled?: boolean;
  enabledTools?: string[] | null;
  disabledTools?: string[];
}

export interface UpdateMcpServer {
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  trust?: McpTrust;
  enabled?: boolean;
  enabledTools?: string[] | null;
  disabledTools?: string[];
}

export interface McpToolSummary {
  name: string;
  description?: string;
  enabled?: boolean;
}

export const mcpServersApi = {
  list: async (client: ApiClient) =>
    (await client.get<{ items: McpServer[] }>("/v1/mcp/servers")).items,
  create: (client: ApiClient, input: SaveMcpServer) =>
    client.post<McpServer>("/v1/mcp/servers", input),
  update: (client: ApiClient, id: string, patch: UpdateMcpServer) =>
    client.patch<McpServer>(`/v1/mcp/servers/${encodeURIComponent(id)}`, patch),
  delete: (client: ApiClient, id: string) =>
    client.delete(`/v1/mcp/servers/${encodeURIComponent(id)}`),
  reconnect: (client: ApiClient, id: string) =>
    client.post<McpServer>(`/v1/mcp/servers/${encodeURIComponent(id)}/reconnect`, {}),
  tools: async (client: ApiClient, id: string) =>
    (await client.get<{ items: McpToolSummary[] }>(`/v1/mcp/servers/${encodeURIComponent(id)}/tools`)).items,
};
