import type { ApiClient } from "./client";

export type WebSearchProviderId = "duckduckgo-html" | "searxng";

export interface WebSearchSettings {
  provider: WebSearchProviderId;
  searxngBaseUrl: string | null;
  updatedAt: string;
}

export interface WebSearchProviderDescriptor {
  id: WebSearchProviderId;
  label: string;
  requiresBaseUrl: boolean;
}

export interface WebSearchSettingsResponse {
  settings: WebSearchSettings;
  providers: WebSearchProviderDescriptor[];
}

export interface UpdateWebSearchSettings {
  provider?: WebSearchProviderId;
  searxngBaseUrl?: string | null;
}

export interface WebSearchTestResult {
  ok: boolean;
  provider: WebSearchProviderId;
  query: string;
  resultCount: number;
  sample: { title: string; url: string } | null;
  error?: string;
}

export const webSearchSettingsApi = {
  get: (client: ApiClient) =>
    client.get<WebSearchSettingsResponse>("/v1/web-search/settings"),
  update: (client: ApiClient, input: UpdateWebSearchSettings) =>
    client.patch<WebSearchSettingsResponse>("/v1/web-search/settings", input),
  test: (client: ApiClient, input: UpdateWebSearchSettings & { query?: string }) =>
    client.post<WebSearchTestResult>("/v1/web-search/test", input),
};
