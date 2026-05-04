import type { ApiClient } from "./client";

export interface ModelCatalogEntry {
  id: string;
  modelRef: string;
  name: string;
  reasoning: boolean;
  input: string[];
}

export interface AuthProfileView {
  id: string;
  provider: string;
  mode: "api_key" | "oauth" | "token" | "none";
  label: string;
  status: "configured" | "missing" | "expired" | "error" | "unsupported";
  email?: string;
  expiresAt?: number;
  message?: string;
}

export interface ModelProviderView {
  id: string;
  name: string;
  baseUrl?: string | null;
  api?: string;
  auth?: string;
  models: ModelCatalogEntry[];
  authProfiles: AuthProfileView[];
  authOrder: string[];
}

export interface ModelSettingsResponse {
  providers: ModelProviderView[];
}

export interface ModelTestRequest {
  modelRef: string;
}

export interface ModelTestResult {
  ok: boolean;
  provider: string;
  model: string;
  profileId?: string;
  message: string;
}

export const modelSettingsApi = {
  get: (client: ApiClient) => client.get<ModelSettingsResponse>("/v1/model-settings"),
  test: (client: ApiClient, input: ModelTestRequest) =>
    client.post<ModelTestResult>("/v1/model-settings/test", input),
};
