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
      profileId: null,
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
      profileId: null,
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
      profileId: null,
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
    expect(ModelApiSchema.parse("responses")).toBe("responses");
    expect(ModelProviderAuthModeSchema.parse("oauth")).toBe("oauth");
    expect(ModelInputTypeSchema.parse("text")).toBe("text");
    expect(AuthProfileModeSchema.parse("oauth")).toBe("oauth");
    expect(AuthProfileStatusSchema.parse("configured")).toBe("configured");
    expect(UpdateModelAuthOrderSchema.parse({ authOrder: ["codex"] })).toEqual({
      authOrder: ["codex"],
    });
  });

  test("parses configured OpenAI OAuth profile settings", () => {
    const parsed = ModelSettingsResponseSchema.parse({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          api: "responses",
          authModes: ["oauth", "api_key"],
          models: [
            {
              id: "gpt-5.5",
              modelRef: "openai/gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 400000,
              maxTokens: 128000,
              compat: ["agents-sdk"],
            },
          ],
          authProfiles: [
            {
              id: "codex",
              label: "Codex",
              mode: "oauth",
              status: "configured",
              isDefault: true,
              accountLabel: "dev@example.com",
            },
          ],
          authOrder: ["codex", "api-key"],
        },
      ],
    });

    expect(parsed.providers[0]?.authProfiles[0]?.mode).toBe("oauth");
    expect(parsed.providers[0]?.authProfiles[0]?.status).toBe("configured");
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
        label: "API key",
        mode: "api_key",
        status: "missing",
      }),
    ).toEqual({
      id: "api-key",
      label: "API key",
      mode: "api_key",
      status: "missing",
      isDefault: false,
    });

    expect(
      ModelProviderViewSchema.parse({
        id: "openai",
        name: "OpenAI",
        api: "responses",
        authModes: ["oauth"],
        models: [],
        authProfiles: [],
        authOrder: [],
      }),
    ).toEqual({
      id: "openai",
      name: "OpenAI",
      api: "responses",
      authModes: ["oauth"],
      models: [],
      authProfiles: [],
      authOrder: [],
    });
  });
});
