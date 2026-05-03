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
      env: {},
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
