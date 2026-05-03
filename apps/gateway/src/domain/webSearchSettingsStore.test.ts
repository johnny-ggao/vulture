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
  test("returns multi-engine fallback defaults when no settings file exists", () => {
    const { store, cleanup } = tempStore();
    try {
      expect(store.get()).toMatchObject({
        provider: "multi",
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

  test("accepts each scrape-based provider id without extra fields", () => {
    const { store, cleanup } = tempStore();
    try {
      for (const provider of ["multi", "duckduckgo-html", "bing-html", "brave-html"] as const) {
        const updated = store.update({ provider });
        expect(updated.provider).toBe(provider);
        expect(updated.searxngBaseUrl).toBeNull();
        expect(updated.braveApiKey).toBeNull();
      }
    } finally {
      cleanup();
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
