import { describe, expect, test } from "bun:test";
import {
  ModelSettingsResponseSchema,
  parseModelRefWithProfile,
} from "./modelConfig";

describe("parseModelRefWithProfile", () => {
  test("parses provider, model, and explicit auth profile", () => {
    expect(parseModelRefWithProfile("openai/gpt-5.5@codex")).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "codex",
    });
  });

  test("keeps date suffixes as part of the model id", () => {
    expect(parseModelRefWithProfile("anthropic/claude-sonnet@20251001")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet@20251001",
      authProfileId: null,
    });
  });

  test("parses auth profile after a date-suffixed model id", () => {
    expect(parseModelRefWithProfile("anthropic/claude-sonnet@20251001@work")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet@20251001",
      authProfileId: "work",
    });
  });

  test("keeps local quant suffixes as part of the model id", () => {
    expect(parseModelRefWithProfile("ollama/gemma@q8_0")).toEqual({
      provider: "ollama",
      model: "gemma@q8_0",
      authProfileId: null,
    });
  });

  test("parses auth profile after a quant-suffixed model id", () => {
    expect(parseModelRefWithProfile("ollama/gemma@q8_0@lab")).toEqual({
      provider: "ollama",
      model: "gemma@q8_0",
      authProfileId: "lab",
    });
  });

  test("defaults bare model ids to OpenAI", () => {
    expect(parseModelRefWithProfile("gpt-5.4")).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: null,
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
  test("parses configured OpenAI OAuth profile settings", () => {
    const parsed = ModelSettingsResponseSchema.parse({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              supportsOAuth: true,
              supportsApiKey: true,
            },
          ],
          authProfiles: [
            {
              id: "codex",
              label: "Codex",
              kind: "oauth",
              configured: true,
              isDefault: true,
              accountLabel: "dev@example.com",
            },
          ],
        },
      ],
      selectedModel: {
        provider: "openai",
        model: "gpt-5.5",
        authProfileId: "codex",
      },
      authOrder: ["codex", "api-key"],
    });

    expect(parsed.providers[0]?.authProfiles[0]?.kind).toBe("oauth");
    expect(parsed.selectedModel.authProfileId).toBe("codex");
    expect(parsed.authOrder).toEqual(["codex", "api-key"]);
  });
});
