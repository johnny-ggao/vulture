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
      await expect(res.json()).resolves.toMatchObject({
        settings: { provider: "duckduckgo-html", searxngBaseUrl: null },
        providers: [
          { id: "duckduckgo-html", requiresBaseUrl: false },
          { id: "searxng", requiresBaseUrl: true },
        ],
      });
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
        settings: { provider: "duckduckgo-html" },
      });
    } finally {
      cleanup();
    }
  });
});
