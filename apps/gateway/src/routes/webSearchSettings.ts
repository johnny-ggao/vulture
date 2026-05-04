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
  description: string;
  requiresBaseUrl: boolean;
  requiresApiKey: boolean;
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
  {
    id: "multi",
    label: "Auto (DDG → Bing → Brave)",
    description:
      "Free, zero-config. Tries each engine's HTML page and falls back automatically when one is rate-limited.",
    requiresBaseUrl: false,
    requiresApiKey: false,
  },
  {
    id: "duckduckgo-html",
    label: "DuckDuckGo (HTML)",
    description: "Scrapes duckduckgo.com/html. Free; no API key.",
    requiresBaseUrl: false,
    requiresApiKey: false,
  },
  {
    id: "bing-html",
    label: "Bing (HTML)",
    description: "Scrapes bing.com/search. Free; no API key.",
    requiresBaseUrl: false,
    requiresApiKey: false,
  },
  {
    id: "brave-html",
    label: "Brave Search (HTML)",
    description: "Scrapes search.brave.com. Free; no API key.",
    requiresBaseUrl: false,
    requiresApiKey: false,
  },
  {
    id: "brave-api",
    label: "Brave Search API",
    description:
      "Official Brave Search API. Higher quality, 2000 free queries/month. Requires an API key from search.brave.com/api.",
    requiresBaseUrl: false,
    requiresApiKey: true,
  },
  {
    id: "tavily-api",
    label: "Tavily Search API",
    description:
      "Tavily AI search API with native readable-content extraction. 1000 free queries/month. Easier signup than Brave. Requires an API key from app.tavily.com.",
    requiresBaseUrl: false,
    requiresApiKey: true,
  },
  {
    id: "perplexity-api",
    label: "Perplexity (Sonar)",
    description:
      "Perplexity Sonar API. Returns AI-synthesized answers with citations. Requires an API key from perplexity.ai/settings/api.",
    requiresBaseUrl: false,
    requiresApiKey: true,
  },
  {
    id: "gemini-search",
    label: "Gemini Grounding",
    description:
      "Google's Gemini model with Google Search grounding. Returns AI-synthesized answers with citations. Requires a Gemini API key from aistudio.google.com.",
    requiresBaseUrl: false,
    requiresApiKey: true,
  },
  {
    id: "searxng",
    label: "SearXNG",
    description: "Self-hosted or public SearXNG instance. Requires a base URL.",
    requiresBaseUrl: true,
    requiresApiKey: false,
  },
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
    braveApiKey: nullableString(value.braveApiKey),
    tavilyApiKey: nullableString(value.tavilyApiKey),
    perplexityApiKey: nullableString(value.perplexityApiKey),
    geminiApiKey: nullableString(value.geminiApiKey),
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
  const braveApiKey =
    input.braveApiKey !== undefined ? input.braveApiKey : current.braveApiKey;
  const tavilyApiKey =
    input.tavilyApiKey !== undefined ? input.tavilyApiKey : current.tavilyApiKey;
  const perplexityApiKey =
    input.perplexityApiKey !== undefined ? input.perplexityApiKey : current.perplexityApiKey;
  const geminiApiKey =
    input.geminiApiKey !== undefined ? input.geminiApiKey : current.geminiApiKey;
  if (provider === "searxng" && !searxngBaseUrl) {
    throw new Error("searxngBaseUrl is required");
  }
  if (provider === "brave-api" && !braveApiKey) {
    throw new Error("braveApiKey is required");
  }
  if (provider === "tavily-api" && !tavilyApiKey) {
    throw new Error("tavilyApiKey is required");
  }
  if (provider === "perplexity-api" && !perplexityApiKey) {
    throw new Error("perplexityApiKey is required");
  }
  // Gemini falls back to the Gemini model auth key when the per-search key
  // is blank, so don't reject empty keys here.
  return {
    ...current,
    provider,
    searxngBaseUrl,
    braveApiKey,
    tavilyApiKey,
    perplexityApiKey,
    geminiApiKey,
  };
}

function providerField(value: unknown): WebSearchProviderId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("provider is invalid");
  const allowed: WebSearchProviderId[] = [
    "multi",
    "duckduckgo-html",
    "bing-html",
    "brave-html",
    "brave-api",
    "tavily-api",
    "perplexity-api",
    "gemini-search",
    "searxng",
  ];
  if (allowed.includes(value as WebSearchProviderId)) return value as WebSearchProviderId;
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
