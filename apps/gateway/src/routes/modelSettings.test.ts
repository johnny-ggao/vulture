import { describe, expect, test } from "bun:test";
import { ModelSettingsResponseSchema } from "@vulture/protocol/src/v1/modelConfig";
import type { ModelSettingsFetch } from "../domain/modelAuth";
import { modelSettingsRouter } from "./modelSettings";

function app(opts: {
  env?: Record<string, string | undefined>;
  fetch?: ModelSettingsFetch;
} = {}) {
  return modelSettingsRouter({
    shellCallbackUrl: "http://shell.test",
    shellToken: "test-token",
    env: opts.env ?? {},
    fetch: opts.fetch ?? (async () => new Response(null, { status: 404 })),
  });
}

describe("/v1/model-settings", () => {
  test("returns unified OpenAI provider with Codex OAuth and OpenAI API key", async () => {
    const fetchCalls: Array<{ url: string; authorization: string | null }> = [];
    const res = await app({
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        fetchCalls.push({
          url: String(input),
          authorization: headers.get("Authorization"),
        });
        return Response.json({
          profiles: [
            {
              id: "codex",
              provider: "openai",
              mode: "oauth",
              label: "ChatGPT / Codex",
              status: "configured",
              email: "dev@example.com",
              expires_at: 1_800_000_000,
              source: "shell",
            },
          ],
          auth_order: { openai: ["codex"] },
        });
      },
    }).request("/v1/model-settings");

    expect(res.status).toBe(200);
    const body = ModelSettingsResponseSchema.parse(await res.json());
    expect(fetchCalls).toEqual([
      {
        url: "http://shell.test/auth/model-profiles",
        authorization: "Bearer test-token",
      },
    ]);
    expect(body.providers.some((provider) => provider.id === "gateway")).toBe(false);

    const openai = body.providers.find((provider) => provider.id === "openai");
    expect(openai).toBeDefined();
    expect(openai).toMatchObject({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      auth: "api-key",
      authOrder: ["codex", "openai-api-key"],
    });
    expect(openai?.models.map((model) => model.modelRef)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
    ]);
    expect(openai?.authProfiles).toEqual([
      {
        id: "codex",
        provider: "openai",
        mode: "oauth",
        label: "ChatGPT / Codex",
        status: "configured",
        email: "dev@example.com",
        expiresAt: 1_800_000_000,
      },
      {
        id: "openai-api-key",
        provider: "openai",
        mode: "api_key",
        label: "OpenAI API Key",
        status: "configured",
      },
    ]);
  });

  test("returns catalog with missing OpenAI API key when shell fetch fails", async () => {
    const res = await app({
      env: {},
      fetch: async () => {
        throw new Error("shell offline");
      },
    }).request("/v1/model-settings");

    expect(res.status).toBe(200);
    const body = ModelSettingsResponseSchema.parse(await res.json());
    const openai = body.providers.find((provider) => provider.id === "openai");
    expect(openai?.authProfiles).toContainEqual({
      id: "openai-api-key",
      provider: "openai",
      mode: "api_key",
      label: "OpenAI API Key",
      status: "missing",
    });
    expect(openai?.authOrder).toEqual(["openai-api-key"]);
  });

  test("projects Anthropic API key configured from env", async () => {
    const res = await app({
      env: { ANTHROPIC_API_KEY: "anthropic-test" },
    }).request("/v1/model-settings");

    expect(res.status).toBe(200);
    const body = ModelSettingsResponseSchema.parse(await res.json());
    const anthropic = body.providers.find((provider) => provider.id === "anthropic");
    expect(anthropic?.authOrder).toEqual(["anthropic-api-key"]);
    expect(anthropic?.authProfiles).toContainEqual({
      id: "anthropic-api-key",
      provider: "anthropic",
      mode: "api_key",
      label: "Anthropic API Key",
      status: "configured",
    });
    expect(anthropic?.authProfiles).toContainEqual(
      expect.objectContaining({
        id: "anthropic-oauth",
        status: "unsupported",
      }),
    );
  });

  test("projects Anthropic API key configured from shell keychain profile", async () => {
    const res = await app({
      env: {},
      fetch: async () => Response.json({
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
    }).request("/v1/model-settings");

    expect(res.status).toBe(200);
    const body = ModelSettingsResponseSchema.parse(await res.json());
    const anthropic = body.providers.find((provider) => provider.id === "anthropic");
    expect(anthropic?.authProfiles).toContainEqual({
      id: "anthropic-api-key",
      provider: "anthropic",
      mode: "api_key",
      label: "Anthropic API Key",
      status: "configured",
    });
  });

  test("projects Anthropic API key missing without env", async () => {
    const res = await app({ env: {} }).request("/v1/model-settings");

    expect(res.status).toBe(200);
    const body = ModelSettingsResponseSchema.parse(await res.json());
    const anthropic = body.providers.find((provider) => provider.id === "anthropic");
    expect(anthropic?.authProfiles).toContainEqual({
      id: "anthropic-api-key",
      provider: "anthropic",
      mode: "api_key",
      label: "Anthropic API Key",
      status: "missing",
    });
  });

  test("POST /v1/model-settings/test rejects missing modelRef", async () => {
    const res = await modelSettingsRouter({
      shellCallbackUrl: "http://shell.test",
      shellToken: "test-token",
      env: {},
      fetch: async () => new Response(null, { status: 404 }),
    }).request("/v1/model-settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "model.test_invalid_input" });
  });

  test("POST /v1/model-settings/test surfaces resolver auth-missing errors as ok=false", async () => {
    const res = await modelSettingsRouter({
      shellCallbackUrl: "http://shell.test",
      shellToken: "test-token",
      env: {},
      fetch: async () => new Response(null, { status: 404 }),
      probeFetch: async () => new Response("should not be called", { status: 200 }),
    }).request("/v1/model-settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelRef: "google/gemini-2.5-flash" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      provider: "google",
      model: "gemini-2.5-flash",
      profileId: "gemini-api-key",
    });
    expect(body.message).toContain("Gemini");
  });

  test("POST /v1/model-settings/test reports ok=true when probe succeeds", async () => {
    let probedUrl = "";
    const res = await modelSettingsRouter({
      shellCallbackUrl: "http://shell.test",
      shellToken: "test-token",
      env: { GEMINI_API_KEY: "AIza-test" },
      fetch: async () => new Response(null, { status: 404 }),
      probeFetch: async (url) => {
        probedUrl = String(url);
        return Response.json({ models: [{ name: "models/gemini-2.5-flash" }] });
      },
    }).request("/v1/model-settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelRef: "google/gemini-2.5-flash" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      provider: "google",
      model: "gemini-2.5-flash",
      profileId: "gemini-api-key",
    });
    expect(body.message).toContain("Gemini auth ok");
    expect(probedUrl).toContain("/v1beta/models?key=AIza-test");
  });

  test("POST /v1/model-settings/test reports ok=false on upstream auth failure", async () => {
    const res = await modelSettingsRouter({
      shellCallbackUrl: "http://shell.test",
      shellToken: "test-token",
      env: { OPENAI_API_KEY: "sk-bogus" },
      fetch: async () => new Response(null, { status: 404 }),
      probeFetch: async () =>
        new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    }).request("/v1/model-settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelRef: "openai/gpt-5.5" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      provider: "openai",
      profileId: "openai-api-key",
    });
    expect(body.message).toContain("HTTP 401");
    expect(body.message).toContain("Invalid API key");
  });
});
