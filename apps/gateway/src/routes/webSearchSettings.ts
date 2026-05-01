import { Hono } from "hono";
import type {
  UpdateWebSearchSettingsInput,
  WebSearchProviderId,
  WebSearchSettings,
  WebSearchSettingsStore,
} from "../domain/webSearchSettingsStore";
import {
  createWebAccessService,
  searchProviderFromSettings,
  type FetchLike,
} from "../runtime/webAccess";

export interface WebSearchProviderDescriptor {
  id: WebSearchProviderId;
  label: string;
  requiresBaseUrl: boolean;
}

export interface WebSearchSettingsResponse {
  settings: WebSearchSettings;
  providers: WebSearchProviderDescriptor[];
}

export interface WebSearchTestResult {
  ok: boolean;
  provider: WebSearchProviderId;
  query: string;
  resultCount: number;
  sample: { title: string; url: string } | null;
  error?: string;
}

export interface WebSearchSettingsRouterDeps {
  store: WebSearchSettingsStore;
  testSearch: (
    settings: WebSearchSettings,
    query: string,
  ) => Promise<WebSearchTestResult>;
}

export const WEB_SEARCH_PROVIDER_DESCRIPTORS: WebSearchProviderDescriptor[] = [
  { id: "duckduckgo-html", label: "DuckDuckGo HTML", requiresBaseUrl: false },
  { id: "searxng", label: "SearXNG", requiresBaseUrl: true },
];

export function makeWebSearchSettingsTester(fetchImpl: FetchLike = fetch) {
  return async (
    settings: WebSearchSettings,
    query: string,
  ): Promise<WebSearchTestResult> => {
    try {
      const service = createWebAccessService({
        fetch: fetchImpl,
        resolveSearchProvider: ({ fetch }) => searchProviderFromSettings(settings, fetch),
      });
      const result = await service.search({ query, limit: 3 });
      return {
        ok: true,
        provider: settings.provider,
        query,
        resultCount: result.results.length,
        sample: result.results[0] ?? null,
      };
    } catch (cause) {
      return {
        ok: false,
        provider: settings.provider,
        query,
        resultCount: 0,
        sample: null,
        error: errorMessage(cause),
      };
    }
  };
}

export function webSearchSettingsRouter(deps: WebSearchSettingsRouterDeps): Hono {
  const app = new Hono();

  app.get("/v1/web-search/settings", (c) => c.json(toResponse(deps.store.get())));

  app.patch("/v1/web-search/settings", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    try {
      const settings = deps.store.update(parsePatch(raw));
      return c.json(toResponse(settings));
    } catch (err) {
      return c.json({ code: "web_search.invalid_settings", message: errorMessage(err) }, 400);
    }
  });

  app.post("/v1/web-search/test", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    try {
      const input = parseTest(raw);
      const settings = normalizeTestSettings(deps.store.get(), input);
      return c.json(await deps.testSearch(settings, input.query));
    } catch (err) {
      return c.json({ code: "web_search.test_failed", message: errorMessage(err) }, 400);
    }
  });

  return app;
}

function toResponse(settings: WebSearchSettings): WebSearchSettingsResponse {
  return { settings, providers: WEB_SEARCH_PROVIDER_DESCRIPTORS };
}

function parsePatch(raw: unknown): UpdateWebSearchSettingsInput {
  if (!raw || typeof raw !== "object") throw new Error("body must be an object");
  const value = raw as Record<string, unknown>;
  return {
    provider: providerField(value.provider),
    searxngBaseUrl: nullableString(value.searxngBaseUrl),
  };
}

function parseTest(raw: unknown): UpdateWebSearchSettingsInput & { query: string } {
  if (!raw || typeof raw !== "object") throw new Error("body must be an object");
  const value = raw as Record<string, unknown>;
  const query = typeof value.query === "string" && value.query.trim()
    ? value.query.trim()
    : "Vulture web search test";
  return {
    ...parsePatch(raw),
    query,
  };
}

function normalizeTestSettings(
  current: WebSearchSettings,
  input: UpdateWebSearchSettingsInput,
): WebSearchSettings {
  const provider = input.provider ?? current.provider;
  const searxngBaseUrl =
    input.searxngBaseUrl !== undefined ? input.searxngBaseUrl : current.searxngBaseUrl;
  if (provider === "searxng" && !searxngBaseUrl) {
    throw new Error("searxngBaseUrl is required");
  }
  return {
    ...current,
    provider,
    searxngBaseUrl,
  };
}

function providerField(value: unknown): WebSearchProviderId | undefined {
  if (value === undefined) return undefined;
  if (value === "duckduckgo-html" || value === "searxng") return value;
  throw new Error("provider is invalid");
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error("searxngBaseUrl is invalid");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
