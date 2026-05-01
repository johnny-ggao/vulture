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
});
