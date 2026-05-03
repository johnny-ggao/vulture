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
});
