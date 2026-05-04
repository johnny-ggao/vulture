import { describe, expect, test } from "bun:test";
import {
  probeModelConnectivity,
  type ModelConnectivityFetch,
} from "./modelConnectivityTester";

function trackingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetch: ModelConnectivityFetch; calls: Array<{ url: string; headers: Headers }> } {
  const calls: Array<{ url: string; headers: Headers }> = [];
  return {
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, headers: new Headers(init?.headers) });
      return handler(url, init);
    },
    calls,
  };
}

describe("probeModelConnectivity", () => {
  test("OpenAI probe hits /v1/models with Bearer auth and reports model count on success", async () => {
    const tracker = trackingFetch(() =>
      Response.json({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }, { id: "gpt-5.4-mini" }] }),
    );
    const result = await probeModelConnectivity({
      provider: "openai",
      model: "openai/gpt-5.5",
      apiKey: "sk-test",
      fetch: tracker.fetch,
    });
    expect(result).toEqual({ ok: true, message: "OpenAI auth ok · 3 个模型可见" });
    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].url).toBe("https://api.openai.com/v1/models");
    expect(tracker.calls[0].headers.get("authorization")).toBe("Bearer sk-test");
  });

  test("Anthropic probe sends x-api-key + anthropic-version and counts models", async () => {
    const tracker = trackingFetch(() =>
      Response.json({ data: [{ id: "claude-sonnet-4.5" }, { id: "claude-haiku-4-5" }] }),
    );
    const result = await probeModelConnectivity({
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4.5",
      apiKey: "sk-ant-test",
      fetch: tracker.fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Anthropic auth ok");
    expect(result.message).toContain("2 个模型可见");
    expect(tracker.calls[0].url).toBe("https://api.anthropic.com/v1/models");
    expect(tracker.calls[0].headers.get("x-api-key")).toBe("sk-ant-test");
    expect(tracker.calls[0].headers.get("anthropic-version")).toBe("2023-06-01");
  });

  test("Gemini probe puts api key in query string and counts models", async () => {
    const tracker = trackingFetch(() =>
      Response.json({
        models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-2.5-pro" }],
      }),
    );
    const result = await probeModelConnectivity({
      provider: "google",
      model: "google/gemini-2.5-flash",
      apiKey: "AIzaXYZ",
      fetch: tracker.fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Gemini auth ok");
    expect(result.message).toContain("2 个模型可见");
    expect(tracker.calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaXYZ",
    );
    // Gemini auth is in query string; no Authorization header should leak.
    expect(tracker.calls[0].headers.has("authorization")).toBe(false);
  });

  test("non-2xx response surfaces upstream status and parsed error message", async () => {
    const tracker = trackingFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await probeModelConnectivity({
      provider: "openai",
      model: "openai/gpt-5.5",
      apiKey: "sk-bogus",
      fetch: tracker.fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 401");
    expect(result.message).toContain("Invalid API key");
  });

  test("plain-text errors fall back to a truncated body", async () => {
    const tracker = trackingFetch(
      () => new Response("forbidden by policy", { status: 403 }),
    );
    const result = await probeModelConnectivity({
      provider: "google",
      model: "google/gemini-2.5-flash",
      apiKey: "AIza-bogus",
      fetch: tracker.fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 403");
    expect(result.message).toContain("forbidden by policy");
  });

  test("unknown provider returns a structured not-implemented failure", async () => {
    const result = await probeModelConnectivity({
      provider: "mistral",
      model: "mistral/large",
      apiKey: "x",
      fetch: trackingFetch(() => new Response("nope", { status: 200 })).fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("mistral");
    expect(result.message).toContain("not implemented");
  });
});
