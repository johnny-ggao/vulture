import { describe, expect, test } from "bun:test";
import { resolveRuntimeModelProvider } from "./modelProviderResolver";

const shellWithoutCodexFetch = (async (url: string | URL | Request) => {
  const u = typeof url === "string" ? url : url.toString();
  if (u.endsWith("/auth/model-profiles")) {
    return new Response(JSON.stringify({ profiles: [], auth_order: {} }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${u}`);
}) as typeof fetch;

describe("resolveRuntimeModelProvider", () => {
  test("explicit Codex profile missing does not fall back to OpenAI API key", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/auth/model-profiles")) {
        return new Response(
          JSON.stringify({
            profiles: [
              {
                id: "codex",
                provider: "openai",
                mode: "oauth",
                label: "ChatGPT",
                status: "expired",
              },
            ],
            auth_order: { openai: ["codex"] },
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/auth/codex") || u.endsWith("/auth/codex/refresh")) {
        return new Response(
          JSON.stringify({ code: "auth.codex_expired", message: "expired" }),
          { status: 401 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;

    const result = await resolveRuntimeModelProvider({
      modelRef: "openai/gpt-5.5@codex",
      env: { OPENAI_API_KEY: "sk-test" },
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: fetchFn,
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected resolver error");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.5");
    expect(result.profileId).toBe("codex");
    expect(result.message).toContain("Codex");
    expect(result.message).toContain("OpenAI");
  });

  test("OpenAI API key profile works for openai model when no shell Codex profile exists", async () => {
    const result = await resolveRuntimeModelProvider({
      modelRef: "openai/gpt-5.5",
      env: { OPENAI_API_KEY: "sk-test" },
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: shellWithoutCodexFetch,
    });

    expect(result.kind).toBe("provider");
    if (result.kind !== "provider") throw new Error("expected model provider");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.5");
    expect(result.profileId).toBe("openai-api-key");
    expect(result.apiKey).toBe("sk-test");
    expect(result.modelProvider).toBeDefined();
  });

  test("Anthropic missing auth error mentions Anthropic and not OPENAI_API_KEY", async () => {
    const result = await resolveRuntimeModelProvider({
      modelRef: "anthropic/claude-sonnet-4.5",
      env: { ANTHROPIC_API_KEY: "" },
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: shellWithoutCodexFetch,
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected resolver error");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4.5");
    expect(result.message).toContain("Anthropic");
    expect(result.message).not.toContain("OPENAI_API_KEY");
  });

  test("Anthropic API key profile works for anthropic model", async () => {
    const result = await resolveRuntimeModelProvider({
      modelRef: "anthropic/claude-sonnet-4.5",
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: shellWithoutCodexFetch,
    });

    expect(result.kind).toBe("provider");
    if (result.kind !== "provider") throw new Error("expected model provider");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4.5");
    expect(result.profileId).toBe("anthropic-api-key");
    expect(result.apiKey).toBe("sk-ant-test");
    expect(result.modelProvider).toBeDefined();
  });

  test("Anthropic API key profile works from shell keychain credential", async () => {
    const fetchFn = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/auth/model-profiles")) {
        return new Response(
          JSON.stringify({
            profiles: [
              {
                id: "anthropic-api-key",
                provider: "anthropic",
                mode: "api_key",
                label: "Anthropic API Key",
                status: "configured",
              },
            ],
            auth_order: { anthropic: ["anthropic-api-key"] },
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/auth/model-api-key/anthropic-api-key")) {
        return Response.json({ api_key: "sk-ant-keychain" });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;

    const result = await resolveRuntimeModelProvider({
      modelRef: "anthropic/claude-sonnet-4.5",
      env: { ANTHROPIC_API_KEY: "" },
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: fetchFn,
    });

    expect(result.kind).toBe("provider");
    if (result.kind !== "provider") throw new Error("expected model provider");
    expect(result.provider).toBe("anthropic");
    expect(result.profileId).toBe("anthropic-api-key");
    expect(result.apiKey).toBe("sk-ant-keychain");
  });

  test("Gemini API key profile works for google model from env GEMINI_API_KEY", async () => {
    const result = await resolveRuntimeModelProvider({
      modelRef: "google/gemini-2.5-flash",
      env: { GEMINI_API_KEY: "AIza-test" },
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: shellWithoutCodexFetch,
    });

    expect(result.kind).toBe("provider");
    if (result.kind !== "provider") throw new Error("expected model provider");
    expect(result.provider).toBe("google");
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.profileId).toBe("gemini-api-key");
    expect(result.apiKey).toBe("AIza-test");
    expect(result.modelProvider).toBeDefined();
  });

  test("Gemini API key profile also accepts GOOGLE_API_KEY as alias", async () => {
    const result = await resolveRuntimeModelProvider({
      modelRef: "google/gemini-2.5-pro",
      env: { GOOGLE_API_KEY: "AIza-alias" },
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: shellWithoutCodexFetch,
    });

    if (result.kind !== "provider") throw new Error("expected model provider");
    expect(result.apiKey).toBe("AIza-alias");
  });

  test("Gemini missing auth error mentions Gemini and not OPENAI/ANTHROPIC", async () => {
    const result = await resolveRuntimeModelProvider({
      modelRef: "google/gemini-2.5-flash",
      env: {},
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: shellWithoutCodexFetch,
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.profileId).toBe("gemini-api-key");
    expect(result.message).toContain("Gemini");
    expect(result.message).not.toContain("OPENAI");
    expect(result.message).not.toContain("Anthropic");
  });

  test("bare model defaults to openai provider", async () => {
    const result = await resolveRuntimeModelProvider({
      modelRef: "gpt-5.4",
      env: { OPENAI_API_KEY: "sk-test" },
      shellCallbackUrl: "http://shell:4199",
      shellToken: "bearer",
      fetch: shellWithoutCodexFetch,
    });

    expect(result.kind).toBe("provider");
    if (result.kind !== "provider") throw new Error("expected model provider");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4");
    expect(result.profileId).toBe("openai-api-key");
  });
});
