import type { ApiClient } from "./client";

export interface Profile {
  id: string;
  name: string;
  activeAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileRequest {
  name?: string;
  activeAgentId?: string | null;
}

export const profileApi = {
  get: (client: ApiClient) => client.get<Profile>("/v1/profile"),
  update: (client: ApiClient, body: UpdateProfileRequest) =>
    client.patch<Profile>("/v1/profile", body),
};
