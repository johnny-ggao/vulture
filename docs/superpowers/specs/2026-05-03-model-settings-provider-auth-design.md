# Model Settings Provider/Auth Design

Date: 2026-05-03

## Goal

Rework Vulture's model settings and runtime provider resolution so OpenAI API key usage, ChatGPT/Codex OAuth usage, Anthropic API key usage, and future provider integrations share one model/auth architecture.

The target shape is an OpenClaw-compatible subset:

- Models are selected as `provider/model`.
- Provider model catalogs live in a backend-owned model config, not in a frontend-only catalog.
- Auth profiles describe provider credentials and connection methods; they are not synonymous with OAuth.
- Runtime selection resolves a model ref plus auth profile into a per-run OpenAI Agents SDK `ModelProvider`.

## Context

Current Vulture behavior splits OpenAI API key and Codex OAuth across separate frontend providers:

- `apps/desktop-ui/src/chat/Settings/providerCatalog.ts` includes `openai` and `gateway`.
- `apps/gateway/src/runtime/resolveLlm.ts` hardcodes resolution as Codex, then OpenAI API key, then stub fallback.
- `apps/gateway/src/runtime/openaiLlm.ts` already runs through the OpenAI Agents SDK `Runner` with a per-run `modelProvider`.
- `apps/gateway/src/runtime/codexLlm.ts` already adapts ChatGPT/Codex OAuth into an OpenAI-compatible `OpenAIProvider`.

OpenClaw provides the reference shape:

- `openclaw/src/config/types.models.ts` defines `models.providers`.
- `openclaw/src/config/types.auth.ts` defines auth profile metadata and provider order.
- `openclaw/src/agents/auth-profiles/types.ts` separates stored credentials from config metadata.
- `openclaw/src/agents/model-ref-profile.ts` supports `provider/model@profile` while preserving model ids that legitimately contain `@`.

## Non-Goals

- Do not introduce the full OpenClaw plugin system in the first Vulture implementation.
- Do not move Rust Codex OAuth refresh-token storage in the first pass.
- Do not implement every OpenClaw auth rotation feature, such as complete cooldown-based round-robin, before the basic architecture is working.
- Do not replace the OpenAI Agents SDK runner, tool approval bridge, session, resume, or MCP tool path.

## Chosen Approach

Use a unified model config, auth profile store, and runtime provider resolver.

This is a narrower version of OpenClaw's provider architecture. Vulture should adopt the same data boundaries and model ref semantics without taking on OpenClaw's full provider plugin control plane.

Alternatives rejected:

- Keeping the existing frontend catalog and adding backend branches would leave the same split between UI state and runtime state.
- Implementing a full provider plugin system now would be too large for the first provider/auth cleanup.

## Data Model

Vulture should add an OpenClaw-compatible config subset:

```ts
type ModelApi =
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages";

type ModelProviderAuthMode = "api-key" | "oauth" | "token" | "none";

type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image" | "audio" | "video" | "document">;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
};

type ModelProviderConfig = {
  baseUrl?: string;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  models: ModelDefinitionConfig[];
};

type ModelsConfig = {
  providers: Record<string, ModelProviderConfig>;
};
```

Auth profile metadata should mirror OpenClaw's split:

```ts
type AuthProfileConfig = {
  provider: string;
  mode: "api_key" | "oauth" | "token" | "none";
  email?: string;
  displayName?: string;
};

type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
};
```

Stored credential material should live outside the UI config:

```ts
type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  keyRef?: string;
  email?: string;
  displayName?: string;
  metadata?: Record<string, string>;
};

type TokenCredential = {
  type: "token";
  provider: string;
  tokenRef?: string;
  expires?: number;
  email?: string;
  displayName?: string;
};

type OAuthCredential = {
  type: "oauth";
  provider: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  displayName?: string;
  metadata?: Record<string, string>;
};
```

For Codex OAuth, the first implementation may project the existing Rust `codex_auth.json` into an OAuth auth profile instead of migrating the underlying secret store.

## Model References

All model choices should normalize to `provider/model`.

Examples:

- `openai/gpt-5.5`
- `openai/gpt-5.5@codex`
- `anthropic/claude-sonnet-4.5`
- `anthropic/claude-sonnet-4.5@work-api-key`

The optional trailing `@profile` selects an auth profile. Parsing must follow OpenClaw's edge cases:

- `@20251001`-style model version suffixes remain part of the model id.
- local quant suffixes such as `@q8_0` remain part of the model id.
- an auth profile can still be specified as a second suffix.

Agent editing may expose this as two controls, model and connection method, while internal storage can preserve a normalized model ref plus auth profile override.

## Settings UI

The model settings page should be driven by backend catalog/status data.

The frontend should no longer treat `providerCatalog.ts` as the source of truth for real model/provider availability. It can remain as a temporary UI fallback during migration, but the final source should be a backend endpoint that returns:

- provider catalog entries,
- model entries,
- configured auth profiles,
- provider auth order,
- status for each auth profile.

Provider layout:

- Left rail: provider list.
- Right pane: provider details.
- Section 1: model catalog, listing `provider/model` values.
- Section 2: connection methods/auth profiles.
- Section 3: default credential order.

OpenAI should appear as one provider. It should include:

- API key profile management.
- ChatGPT/Codex OAuth profile management using the existing login/logout flow.

`Codex Gateway` should disappear as a separate provider. Its runtime behavior becomes an OpenAI OAuth auth profile.

Anthropic should appear as one provider. It should include:

- API key profile management.
- OAuth profile placeholder/status support for future Claude OAuth.

UI copy should say "connection method" or "credential priority", not "login method", because many providers use API keys, local no-auth access, or bearer tokens.

## Runtime Resolver

Replace the hardcoded `makeLazyLlm` order with a model/auth resolver:

```text
agent model or run model
  -> split trailing auth profile
  -> parse provider/model
  -> resolve auth profile order
  -> resolve credential
  -> build per-run Agents SDK ModelProvider
  -> run existing Runner path
```

OpenAI API key profile:

- provider: `openai`
- credential type: `api_key`
- api: `openai-responses`
- model provider: current `OpenAIProvider({ useResponses: true })`

OpenAI Codex OAuth profile:

- provider: `openai`
- credential type: `oauth`
- api: `openai-codex-responses`
- model provider: current Codex client setup in `codexLlm.ts`
- wire endpoint remains `https://chatgpt.com/backend-api/codex`
- run metadata records provider `openai` and profile `codex`

Anthropic API key profile:

- provider: `anthropic`
- credential type: `api_key`
- api: `anthropic-messages`
- model provider: new native Anthropic Messages adapter

Anthropic OAuth profile:

- provider: `anthropic`
- credential type: `oauth`
- api: `anthropic-messages`
- first pass may return an explicit unsupported/missing-login error if the OAuth flow is not implemented.

Explicit profile selection must be strict. If a user selects `openai/gpt-5.5@codex` and Codex is expired, the resolver should report that profile failure rather than silently billing an API key.

When no profile is explicit, the resolver may follow `auth.order[provider]` and try the next usable profile. Each attempt should be observable in run metadata or logs as provider, model, profile, and failure reason.

## Anthropic ModelProvider Adapter

Add a native Anthropic Messages adapter, for example:

```text
apps/gateway/src/runtime/anthropicModelProvider.ts
```

It should implement the Agents SDK `ModelProvider`/model interface used by `Runner`.

First-pass supported behavior:

- streaming text output,
- tool calls,
- tool results,
- usage accounting,
- provider errors with retryable/status metadata.

Mapping rules:

- system/developer instructions become Anthropic `system`.
- user and assistant content become Anthropic `messages`.
- SDK tool schemas become Anthropic `tools`.
- Anthropic SSE events map back into the SDK model stream events expected by `Runner`.

Deferred capabilities:

- prompt cache tuning,
- extended thinking,
- document/PDF support,
- provider-specific tool schema relaxation,
- OAuth refresh.

## Migration

Model migration:

- Bare OpenAI models such as `gpt-5.4` migrate to `openai/gpt-5.4`.
- Known `gateway/*` values migrate away from a gateway provider. If there is a clear model match, use `openai/<model>@codex`; otherwise preserve the value and show a UI prompt to choose a concrete OpenAI model.
- Unknown values are preserved and shown as unknown instead of being dropped.

Credential migration:

- Existing OpenAI API key becomes an `openai-api-key` auth profile.
- Existing Codex login becomes a `codex` auth profile with provider `openai` and mode `oauth`.
- Existing Codex token storage can remain in Rust and be projected through the resolver/status endpoint during the first pass.

Auth order migration:

If both Codex and API key are configured, preserve the current billing invariant by preferring Codex first unless the user explicitly changes order:

```json
{
  "auth": {
    "order": {
      "openai": ["codex", "openai-api-key"]
    }
  }
}
```

## Error Handling

Provider errors should normalize to `llm.provider_error` with:

- provider,
- model,
- profile id,
- credential type,
- status code when available,
- retryable hint when known.

Messages should name the relevant provider. Missing Anthropic auth should not mention `OPENAI_API_KEY`. Expired Codex OAuth should still tell the user to re-login to ChatGPT/Codex, but as an OpenAI connection profile.

No silent billing fallback is allowed for an explicit profile. Ordered fallback is allowed only when the user has not explicitly selected a profile.

## Testing

Unit tests:

- model ref parsing, including `provider/model@profile`, date suffixes, and quant suffixes,
- auth order resolution,
- strict explicit profile behavior,
- migration from bare models and `gateway/*` values,
- provider-specific missing-auth messages.

Runtime tests:

- OpenAI API key profile resolves to current OpenAI Responses provider,
- Codex OAuth profile resolves to current Codex provider setup,
- expired Codex profile does not silently use an API key when explicit,
- Anthropic fake fetch streams text, tool calls, and usage through the new adapter.

UI tests:

- settings page no longer shows `Codex Gateway` as a provider,
- OpenAI shows API key and ChatGPT/Codex connection methods,
- Anthropic shows API key and OAuth-capable structure,
- agent model selection displays `provider/model`,
- agent connection override can select an auth profile.

## Implementation Order

1. Add shared model ref and auth profile types/parsers.
2. Add backend catalog/status endpoints and temporary migration helpers.
3. Refactor settings UI to read backend catalog/status.
4. Replace `makeLazyLlm` hardcoded selection with provider/auth resolver.
5. Re-home Codex OAuth under OpenAI provider/profile semantics.
6. Add native Anthropic Messages `ModelProvider` adapter.
7. Update agent model picker and persisted model migration.
8. Add tests and remove frontend-only provider truth where possible.

## Acceptance Criteria

- OpenAI appears once in model settings.
- ChatGPT/Codex is an OpenAI connection profile, not a separate model provider.
- Existing OpenAI API key runs still work.
- Existing Codex OAuth runs still work.
- `openai/<model>@codex` does not fallback to API key when Codex is expired.
- Anthropic API key runs through a native Messages adapter.
- Agent model choices use `provider/model`.
- The old static frontend catalog is no longer authoritative for runtime availability.
