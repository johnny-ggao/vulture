import type { ApiClient } from "./client";

export type WebSearchProviderId =
  | "multi"
  | "duckduckgo-html"
  | "bing-html"
  | "brave-html"
  | "brave-api"
  | "tavily-api"
  | "searxng";

export interface WebSearchSettings {
  provider: WebSearchProviderId;
  searxngBaseUrl: string | null;
  braveApiKey: string | null;
  tavilyApiKey: string | null;
  updatedAt: string;
}

export interface WebSearchProviderDescriptor {
  id: WebSearchProviderId;
  label: string;
  description?: string;
  requiresBaseUrl: boolean;
  requiresApiKey: boolean;
}

export interface WebSearchSettingsResponse {
  settings: WebSearchSettings;
  providers: WebSearchProviderDescriptor[];
}

export interface UpdateWebSearchSettings {
  provider?: WebSearchProviderId;
  searxngBaseUrl?: string | null;
  braveApiKey?: string | null;
  tavilyApiKey?: string | null;
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
