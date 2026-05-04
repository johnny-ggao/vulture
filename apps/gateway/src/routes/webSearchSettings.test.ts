import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSearchSettingsStore } from "../domain/webSearchSettingsStore";
import { webSearchSettingsRouter } from "./webSearchSettings";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-web-search-route-"));
  const store = new WebSearchSettingsStore(join(dir, "settings", "web-search.json"));
  return {
    app: webSearchSettingsRouter({
      store,
      testSearch: async (settings, query) => ({
        ok: true,
        provider: settings.provider,
        query,
        resultCount: 1,
        sample: { title: "Example", url: "https://example.com" },
      }),
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("/v1/web-search/settings", () => {
  test("GET returns settings and provider metadata", async () => {
    const { app, cleanup } = fixture();
    try {
      const res = await app.request("/v1/web-search/settings");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.settings).toMatchObject({
        provider: "multi",
        searxngBaseUrl: null,
        braveApiKey: null,
      });
      const providerIds = body.providers.map((p: { id: string }) => p.id);
      expect(providerIds).toEqual([
        "multi",
        "duckduckgo-html",
        "bing-html",
        "brave-html",
        "brave-api",
        "tavily-api",
        "searxng",
      ]);
      const braveApi = body.providers.find((p: { id: string }) => p.id === "brave-api");
      expect(braveApi).toMatchObject({ requiresBaseUrl: false, requiresApiKey: true });
      const tavilyApi = body.providers.find((p: { id: string }) => p.id === "tavily-api");
      expect(tavilyApi).toMatchObject({ requiresBaseUrl: false, requiresApiKey: true });
      const searxng = body.providers.find((p: { id: string }) => p.id === "searxng");
      expect(searxng).toMatchObject({ requiresBaseUrl: true, requiresApiKey: false });
    } finally {
      cleanup();
    }
  });

  test("PATCH persists SearXNG settings", async () => {
    const { app, cleanup } = fixture();
    try {
      const res = await app.request("/v1/web-search/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "searxng",
          searxngBaseUrl: "https://search.example.com",
        }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        settings: {
          provider: "searxng",
          searxngBaseUrl: "https://search.example.com/",
        },
      });
    } finally {
      cleanup();
    }
  });

  test("POST test uses submitted settings without mutating the store", async () => {
    const { app, cleanup } = fixture();
    try {
      const res = await app.request("/v1/web-search/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "OpenAI Agents SDK",
          provider: "searxng",
          searxngBaseUrl: "https://search.example.com",
        }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        provider: "searxng",
        query: "OpenAI Agents SDK",
        resultCount: 1,
      });

      const current = await app.request("/v1/web-search/settings");
      await expect(current.json()).resolves.toMatchObject({
        settings: { provider: "multi" },
      });
    } finally {
      cleanup();
    }
  });

  test("PATCH persists tavily-api with API key and rejects missing key", async () => {
    const { app, cleanup } = fixture();
    try {
      const ok = await app.request("/v1/web-search/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "tavily-api", tavilyApiKey: "tvly-secret" }),
      });
      expect(ok.status).toBe(200);
      await expect(ok.json()).resolves.toMatchObject({
        settings: { provider: "tavily-api", tavilyApiKey: "tvly-secret" },
      });

      const bad = await app.request("/v1/web-search/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "tavily-api", tavilyApiKey: null }),
      });
      expect(bad.status).toBe(400);
      await expect(bad.json()).resolves.toMatchObject({
        code: "web_search.invalid_settings",
      });
    } finally {
      cleanup();
    }
  });

  test("PATCH persists brave-api with API key and rejects missing key", async () => {
    const { app, cleanup } = fixture();
    try {
      const ok = await app.request("/v1/web-search/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "brave-api", braveApiKey: "br-secret" }),
      });
      expect(ok.status).toBe(200);
      await expect(ok.json()).resolves.toMatchObject({
        settings: { provider: "brave-api", braveApiKey: "br-secret" },
      });

      const bad = await app.request("/v1/web-search/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "brave-api", braveApiKey: null }),
      });
      expect(bad.status).toBe(400);
      await expect(bad.json()).resolves.toMatchObject({
        code: "web_search.invalid_settings",
      });
    } finally {
      cleanup();
    }
  });

  test("PATCH rejects unknown provider ids", async () => {
    const { app, cleanup } = fixture();
    try {
      const res = await app.request("/v1/web-search/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-real" }),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: "web_search.invalid_settings",
      });
    } finally {
      cleanup();
    }
  });
});
