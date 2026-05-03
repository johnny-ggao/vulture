import { describe, expect, test } from "bun:test";
import {
  AuthProfileModeSchema,
  AuthProfileStatusSchema,
  AuthProfileViewSchema,
  ModelApiSchema,
  ModelCatalogEntrySchema,
  ModelInputTypeSchema,
  ModelProviderAuthModeSchema,
  ModelProviderViewSchema,
  ModelSettingsResponseSchema,
  UpdateModelAuthOrderSchema,
  parseModelRefWithProfile,
} from "./modelConfig";

describe("parseModelRefWithProfile", () => {
  test("parses provider, model, and explicit auth profile", () => {
    expect(parseModelRefWithProfile("openai/gpt-5.5@codex")).toEqual({
      raw: "openai/gpt-5.5@codex",
      modelRef: "openai/gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      profileId: "codex",
      explicitProfile: true,
    });
  });

  test("keeps date suffixes as part of the model id", () => {
    expect(parseModelRefWithProfile("anthropic/claude-sonnet@20251001")).toEqual({
      raw: "anthropic/claude-sonnet@20251001",
      modelRef: "anthropic/claude-sonnet@20251001",
      provider: "anthropic",
      model: "claude-sonnet@20251001",
      explicitProfile: false,
    });
  });

  test("parses auth profile after a date-suffixed model id", () => {
    expect(parseModelRefWithProfile("anthropic/claude-sonnet@20251001@work")).toEqual({
      raw: "anthropic/claude-sonnet@20251001@work",
      modelRef: "anthropic/claude-sonnet@20251001",
      provider: "anthropic",
      model: "claude-sonnet@20251001",
      profileId: "work",
      explicitProfile: true,
    });
  });

  test("keeps local quant suffixes as part of the model id", () => {
    expect(parseModelRefWithProfile("ollama/gemma@q8_0")).toEqual({
      raw: "ollama/gemma@q8_0",
      modelRef: "ollama/gemma@q8_0",
      provider: "ollama",
      model: "gemma@q8_0",
      explicitProfile: false,
    });
  });

  test("parses auth profile after a quant-suffixed model id", () => {
    expect(parseModelRefWithProfile("ollama/gemma@q8_0@lab")).toEqual({
      raw: "ollama/gemma@q8_0@lab",
      modelRef: "ollama/gemma@q8_0",
      provider: "ollama",
      model: "gemma@q8_0",
      profileId: "lab",
      explicitProfile: true,
    });
  });

  test("defaults bare model ids to OpenAI", () => {
    expect(parseModelRefWithProfile("gpt-5.4")).toEqual({
      raw: "gpt-5.4",
      modelRef: "openai/gpt-5.4",
      provider: "openai",
      model: "gpt-5.4",
      explicitProfile: false,
    });
  });

  test("returns null for empty and invalid refs", () => {
    expect(parseModelRefWithProfile("")).toBeNull();
    expect(parseModelRefWithProfile("   ")).toBeNull();
    expect(parseModelRefWithProfile("/gpt-5.4")).toBeNull();
    expect(parseModelRefWithProfile("openai/")).toBeNull();
    expect(parseModelRefWithProfile("openai/gpt-5.4@")).toBeNull();
  });
});

describe("ModelSettingsResponseSchema", () => {
  test("exports the planned schema names", () => {
    expect(ModelApiSchema.options).toEqual([
      "openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
    ]);
    expect(ModelProviderAuthModeSchema.options).toEqual(["api-key", "oauth", "token", "none"]);
    expect(ModelInputTypeSchema.options).toEqual([
      "text",
      "image",
      "audio",
      "video",
      "document",
    ]);
    expect(AuthProfileModeSchema.options).toEqual(["api_key", "oauth", "token", "none"]);
    expect(AuthProfileStatusSchema.options).toEqual([
      "configured",
      "missing",
      "expired",
      "error",
      "unsupported",
    ]);
    expect(ModelApiSchema.parse("openai-responses")).toBe("openai-responses");
    expect(ModelProviderAuthModeSchema.parse("api-key")).toBe("api-key");
    expect(ModelInputTypeSchema.parse("text")).toBe("text");
    expect(AuthProfileModeSchema.parse("oauth")).toBe("oauth");
    expect(AuthProfileStatusSchema.parse("configured")).toBe("configured");
    expect(UpdateModelAuthOrderSchema.parse({ provider: "openai", authOrder: ["codex"] }))
      .toEqual({
        provider: "openai",
        authOrder: ["codex"],
      });
  });

  test("rejects fields outside the planned wire contract", () => {
    expect(() => ModelApiSchema.parse("responses")).toThrow();
    expect(() => ModelProviderAuthModeSchema.parse("api_key")).toThrow();
    expect(() => ModelInputTypeSchema.parse("file")).toThrow();
    expect(() => AuthProfileStatusSchema.parse("refreshing")).toThrow();
    expect(() => UpdateModelAuthOrderSchema.parse({ authOrder: ["codex"] })).toThrow();
    expect(() =>
      ModelCatalogEntrySchema.parse({
        id: "gpt-5.5",
        modelRef: "openai/gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        input: ["text"],
        compat: ["agents-sdk"],
      }),
    ).toThrow();
    expect(() =>
      AuthProfileViewSchema.parse({
        id: "codex",
        provider: "openai",
        label: "Codex",
        mode: "oauth",
        status: "configured",
        accountLabel: "dev@example.com",
      }),
    ).toThrow();
    expect(() =>
      ModelProviderViewSchema.parse({
        id: "openai",
        name: "OpenAI",
        api: "openai-responses",
        authModes: ["oauth"],
        models: [],
        authProfiles: [],
        authOrder: [],
      }),
    ).toThrow();
  });

  test("parses auth order updates with provider id", () => {
    expect(
      UpdateModelAuthOrderSchema.parse({
        provider: "openai",
        authOrder: ["codex"],
      }),
    ).toEqual({
      provider: "openai",
      authOrder: ["codex"],
    });
  });

  test("parses configured OpenAI OAuth profile settings", () => {
    const parsed = ModelSettingsResponseSchema.parse({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          api: "openai-responses",
          auth: "api-key",
          models: [
            {
              id: "gpt-5.5",
              modelRef: "openai/gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 400000,
              maxTokens: 128000,
              compat: {
                agentsSdk: true,
              },
            },
          ],
          authProfiles: [
            {
              id: "codex",
              provider: "openai",
              label: "Codex",
              mode: "oauth",
              status: "configured",
              email: "dev@example.com",
              expiresAt: 1770000000,
              message: "Signed in",
            },
          ],
          authOrder: ["codex", "api-key"],
        },
      ],
    });

    expect(parsed.providers[0]?.authProfiles[0]?.mode).toBe("oauth");
    expect(parsed.providers[0]?.authProfiles[0]?.status).toBe("configured");
    expect(parsed.providers[0]?.authProfiles[0]?.provider).toBe("openai");
    expect(parsed.providers[0]?.authProfiles[0]?.email).toBe("dev@example.com");
    expect(parsed.providers[0]?.authProfiles[0]?.expiresAt).toBe(1770000000);
    expect(parsed.providers[0]?.authOrder).toEqual(["codex", "api-key"]);
  });

  test("parses provider and catalog entries directly", () => {
    expect(
      ModelCatalogEntrySchema.parse({
        id: "gpt-5.4",
        modelRef: "openai/gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        input: ["text"],
      }),
    ).toEqual({
      id: "gpt-5.4",
      modelRef: "openai/gpt-5.4",
      name: "GPT-5.4",
      reasoning: true,
      input: ["text"],
    });

    expect(
      AuthProfileViewSchema.parse({
        id: "api-key",
        provider: "openai",
        label: "API key",
        mode: "api_key",
        status: "missing",
      }),
    ).toEqual({
      id: "api-key",
      provider: "openai",
      label: "API key",
      mode: "api_key",
      status: "missing",
    });

    expect(
      ModelProviderViewSchema.parse({
        id: "openai",
        name: "OpenAI",
        models: [],
        authProfiles: [],
        authOrder: [],
      }),
    ).toEqual({
      id: "openai",
      name: "OpenAI",
      models: [],
      authProfiles: [],
      authOrder: [],
    });
  });
});
