import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSearchSettingsStore } from "./webSearchSettingsStore";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-web-search-settings-"));
  return {
    store: new WebSearchSettingsStore(join(dir, "settings", "web-search.json")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("WebSearchSettingsStore", () => {
  test("returns DuckDuckGo HTML defaults when no settings file exists", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(store.get()).toMatchObject({
        provider: "duckduckgo-html",
        searxngBaseUrl: null,
        braveApiKey: null,
      });
    } finally {
      cleanup();
    }
  });

  test("persists SearXNG provider settings", () => {
    const { store, cleanup } = tempStore();
    try {
      const updated = store.update({
        provider: "searxng",
        searxngBaseUrl: "https://search.example.com/",
      });
      expect(updated).toMatchObject({
        provider: "searxng",
        searxngBaseUrl: "https://search.example.com/",
        braveApiKey: null,
      });
      expect(store.get()).toEqual(updated);
    } finally {
      cleanup();
    }
  });

  test("rejects SearXNG without an http base URL", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(() => store.update({ provider: "searxng", searxngBaseUrl: null })).toThrow(
        "searxngBaseUrl is required",
      );
      expect(() => store.update({ provider: "searxng", searxngBaseUrl: "file:///tmp" }))
        .toThrow("searxngBaseUrl must be http(s)");
    } finally {
      cleanup();
    }
  });

  test("accepts duckduckgo-html without extra fields", () => {
    const { store, cleanup } = tempStore();
    try {
      const updated = store.update({ provider: "duckduckgo-html" });
      expect(updated.provider).toBe("duckduckgo-html");
      expect(updated.searxngBaseUrl).toBeNull();
      expect(updated.braveApiKey).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("migrates legacy multi/bing-html/brave-html provider ids to duckduckgo-html", () => {
    // Legacy provider ids written by older Vulture builds. The store should
    // silently coerce them to duckduckgo-html on read so the user's saved
    // BYOK keys aren't wiped.
    for (const legacy of ["multi", "bing-html", "brave-html"]) {
      const { store, cleanup } = tempStore();
      try {
        // Bypass the typed update API because the legacy id isn't valid input.
        const fs = require("node:fs") as typeof import("node:fs");
        const filePath = (store as unknown as { path: string }).path;
        fs.mkdirSync(require("node:path").dirname(filePath), { recursive: true });
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            schemaVersion: 1,
            settings: {
              provider: legacy,
              searxngBaseUrl: null,
              braveApiKey: "preserved-key",
              tavilyApiKey: null,
              perplexityApiKey: null,
              geminiApiKey: null,
              updatedAt: "2026-05-01T00:00:00.000Z",
            },
          }),
        );
        const loaded = store.get();
        expect(loaded.provider).toBe("duckduckgo-html");
        expect(loaded.braveApiKey).toBe("preserved-key");
      } finally {
        cleanup();
      }
    }
  });

  test("persists brave-api with an API key and rejects empty keys", () => {
    const { store, cleanup } = tempStore();
    try {
      const updated = store.update({
        provider: "brave-api",
        braveApiKey: "  brave-key-value  ",
      });
      expect(updated).toMatchObject({
        provider: "brave-api",
        braveApiKey: "brave-key-value",
      });

      expect(() => store.update({ provider: "brave-api", braveApiKey: null })).toThrow(
        "braveApiKey is required",
      );
      expect(() => store.update({ provider: "brave-api", braveApiKey: "   " })).toThrow(
        "braveApiKey is required",
      );
    } finally {
      cleanup();
    }
  });

  test("persists tavily-api with an API key and rejects empty keys", () => {
    const { store, cleanup } = tempStore();
    try {
      const updated = store.update({
        provider: "tavily-api",
        tavilyApiKey: "  tvly-key-value  ",
      });
      expect(updated).toMatchObject({
        provider: "tavily-api",
        tavilyApiKey: "tvly-key-value",
      });

      expect(() => store.update({ provider: "tavily-api", tavilyApiKey: null })).toThrow(
        "tavilyApiKey is required",
      );
      expect(() => store.update({ provider: "tavily-api", tavilyApiKey: "   " })).toThrow(
        "tavilyApiKey is required",
      );
    } finally {
      cleanup();
    }
  });

  test("persists perplexity-api with an API key and rejects empty keys", () => {
    const { store, cleanup } = tempStore();
    try {
      const updated = store.update({
        provider: "perplexity-api",
        perplexityApiKey: "pplx-key",
      });
      expect(updated).toMatchObject({
        provider: "perplexity-api",
        perplexityApiKey: "pplx-key",
      });
      expect(() => store.update({ provider: "perplexity-api", perplexityApiKey: null })).toThrow(
        "perplexityApiKey is required",
      );
    } finally {
      cleanup();
    }
  });

  test("persists gemini-search with an API key and tolerates a blank key (model-auth fallback)", () => {
    const { store, cleanup } = tempStore();
    try {
      const updated = store.update({
        provider: "gemini-search",
        geminiApiKey: "AIzaXYZ",
      });
      expect(updated).toMatchObject({
        provider: "gemini-search",
        geminiApiKey: "AIzaXYZ",
      });

      // Blank key is intentionally allowed: at runtime we fall back to the
      // shell-stored Gemini model auth key.
      const cleared = store.update({ provider: "gemini-search", geminiApiKey: null });
      expect(cleared.provider).toBe("gemini-search");
      expect(cleared.geminiApiKey).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("rejects unknown provider ids", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(() =>
        // @ts-expect-error - intentionally invalid input
        store.update({ provider: "google-real" }),
      ).toThrow("provider is invalid");
    } finally {
      cleanup();
    }
  });
});
