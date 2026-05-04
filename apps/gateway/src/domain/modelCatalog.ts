import type {
  ModelCatalogEntry,
  ModelInputType,
  ModelProviderView,
} from "@vulture/protocol/src/v1/modelConfig";

export function baseModelProviders(): ModelProviderView[] {
  return [
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      auth: "api-key",
      models: [
        model("openai", "gpt-5.5", "GPT-5.5", true, ["text", "image"]),
        model("openai", "gpt-5.4", "GPT-5.4", true, ["text", "image"]),
        model("openai", "gpt-5.4-mini", "GPT-5.4 Mini", true, ["text", "image"]),
      ],
      authProfiles: [],
      authOrder: [],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      auth: "api-key",
      models: [
        model("anthropic", "claude-sonnet-4.5", "Claude Sonnet 4.5", true, [
          "text",
          "image",
        ]),
        model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", false, [
          "text",
          "image",
        ]),
        model("anthropic", "claude-opus-4", "Claude Opus 4", true, [
          "text",
          "image",
        ]),
      ],
      authProfiles: [
        {
          id: "anthropic-oauth",
          provider: "anthropic",
          mode: "oauth",
          label: "Claude OAuth",
          status: "unsupported",
          message: "Claude OAuth is not supported by the gateway yet.",
        },
      ],
      authOrder: ["anthropic-api-key"],
    },
    {
      id: "google",
      name: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      api: "gemini-generate-content",
      auth: "api-key",
      models: [
        model("google", "gemini-3.1-pro-preview", "Gemini 3.1 Pro (Preview)", true, ["text", "image"]),
        model("google", "gemini-3-flash-preview", "Gemini 3 Flash (Preview)", true, ["text", "image"]),
        model("google", "gemini-2.5-pro", "Gemini 2.5 Pro", true, ["text", "image"]),
        model("google", "gemini-2.5-flash", "Gemini 2.5 Flash", true, ["text", "image"]),
      ],
      authProfiles: [],
      authOrder: ["gemini-api-key"],
    },
  ];
}

function model(
  provider: string,
  id: string,
  name: string,
  reasoning: boolean,
  input: ModelInputType[],
): ModelCatalogEntry {
  return { id, modelRef: `${provider}/${id}`, name, reasoning, input };
}
