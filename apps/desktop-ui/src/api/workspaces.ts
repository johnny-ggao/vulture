import type { ApiClient } from "./client";

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveWorkspaceRequest {
  id: string;
  name: string;
  path: string;
}

export const workspacesApi = {
  list: async (client: ApiClient) =>
    (await client.get<{ items: Workspace[] }>("/v1/workspaces")).items,
  save: (client: ApiClient, body: SaveWorkspaceRequest) =>
    client.post<Workspace>("/v1/workspaces", body),
  delete: (client: ApiClient, id: string) => client.delete(`/v1/workspaces/${id}`),
};
