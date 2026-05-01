# Model Provider System Design

Date: 2026-05-01

## Goal

Add a first-class multi-model system to Vulture, modeled after the useful parts
of Openclaw's provider catalog and auth profile design. The system should let an
agent select a concrete `provider/model`, manage provider credentials, and run
through stable runtime adapters without hard-coding one global OpenAI path.

The first implementation phase should build the complete architecture and make
the OpenAI-compatible provider family usable. It should not claim support for
providers whose runtime adapter has not been built.

## Context

Vulture currently resolves LLMs through a fixed order in
`makeLazyLlm`: ChatGPT/Codex token, OpenAI API key, then stub fallback. The
actual run path is already reasonably well-shaped: `makeOpenAILlm` accepts a
per-run OpenAI Agents SDK `ModelProvider`, and `makeCodexLlm` already avoids
process-global SDK client mutation by passing a provider into the `Runner`.

Openclaw has a richer model system:

- `models.json` stores providers keyed by provider id.
- Providers declare `baseUrl`, `api`, `auth`, headers, and model definitions.
- Model references are normalized as `provider/model`.
- Agents can use a primary model plus fallbacks.
- Auth profiles are separate from provider catalog data.
- Provider discovery can add implicit providers from env vars or auth profiles.

Vulture should absorb that shape, but keep the first phase smaller and more
aligned with OpenAI Agents SDK semantics.

## Non-Goals

- Do not implement real Anthropic, Gemini, or Bedrock runtime adapters in the
  first phase.
- Do not add cost tracking.
- Do not build a provider plugin marketplace.
- Do not add automatic model selection based on price, speed, or load.
- Do not silently switch from a subscription/auth provider to a paid API-key
  provider unless the agent explicitly configured that fallback.
- Do not rewrite the tool system or approval flow.

## Data Model

Add stable protocol schemas for model providers, model definitions, auth
profiles, and agent model configuration.

`ModelProvider`

```text
id          string
name        string
api         openai_responses | openai_compatible | anthropic_messages |
            google_generative | bedrock_converse
baseUrl     string
authMode    api_key | token | oauth | aws | none
headers     record<string, string>
enabled     boolean
status      available | missing_auth | planned | disabled | error
models      ModelDefinition[]
```

`ModelDefinition`

```text
id              string
providerId      string
name            string
input           text[] where values are text or image
reasoning       boolean
contextWindow   number
maxOutputTokens number
compat          object
```

`compat` should include the flags needed by the runtime, such as
`supportsTools`, `supportsStreamingUsage`, `supportsReasoningEffort`,
`supportsStrictToolSchema`, and `supportsResponsesApi`.

`ModelAuthProfile`

```text
id          string
providerId  string
label       string
kind        api_key | token | oauth | aws_profile
secretRef   string | null
metadata    object
createdAt   iso8601
updatedAt   iso8601
```

The first phase may store secrets in SQLite if that matches the current local
product baseline, but API and store boundaries must use a `secretRef` style so
OS keychain or encrypted storage can replace the implementation later.

`AgentModelConfig`

```ts
type AgentModelConfig =
  | string
  | {
      primary?: string;      // provider/model
      fallbacks?: string[];  // provider/model
    };
```

Keep the existing `agents.model` string column for compatibility. Add a
`model_config_json` column. Reads prefer `model_config_json`; if it is missing,
the store maps the legacy `model` string into `{ primary }`. Writes should also
update `model` with the primary value so old code paths keep working during the
transition.

## Provider Catalog

Seed built-in providers:

- `openai-codex`: ChatGPT/Codex subscription token path.
- `openai`: OpenAI API key path.
- `openrouter`: OpenAI-compatible HTTP API.
- `deepseek`: OpenAI-compatible HTTP API.
- `qwen`: OpenAI-compatible HTTP API.
- `ollama`: local OpenAI-compatible style provider where possible.
- `lmstudio`: local OpenAI-compatible provider.
- `vllm`: local or remote OpenAI-compatible provider.
- `anthropic`: planned/disabled until an adapter exists.
- `google`: planned/disabled until an adapter exists.
- `amazon-bedrock`: planned/disabled until an adapter exists.

OpenAI-compatible providers should be editable: base URL, auth profile, headers,
and model list. The model list can be seeded and later refreshed by a provider
specific discovery method where available.

## Runtime Architecture

Introduce `ModelRuntimeResolver`. It replaces the fixed provider order in
`makeLazyLlm` with explicit model resolution:

1. Resolve the agent's primary model reference.
2. Validate provider enabled state, auth availability, and adapter support.
3. Construct a provider-specific runtime adapter.
4. If primary is unavailable, try configured fallbacks in order.
5. If none work, return a clear final configuration message through the stub
   fallback.

The resolver returns both the `LlmCallable` and a resolved runtime descriptor:

```text
providerId
providerApi
modelId
modelRef
authProfileId
fallbackIndex
```

This descriptor should be written into run recovery metadata and emitted in
`run.started` or a companion run metadata event so logs show the actual provider
and model used.

## Runtime Adapters

`openai_responses`

- Covers current OpenAI API key path.
- Covers current ChatGPT/Codex token path through the existing Codex-specific
  OpenAI client and SSE patch.
- Continues to use OpenAI Agents SDK `Runner` with a per-run `ModelProvider`.
- Preserves SDK approvals, HITL resume, tool execution, token usage, and run
  recovery behavior.

`openai_compatible`

- Covers OpenRouter, DeepSeek, Qwen, Ollama, LM Studio, and vLLM in phase one.
- Uses OpenAI SDK client with provider `baseUrl`, API key, and configured
  headers.
- If a provider supports Responses API, route through the same Agents SDK
  adapter as OpenAI.
- If a provider only supports Chat Completions, either mark it unsupported for
  tools in phase one or add an explicit degraded bridge. Do not pretend tool
  semantics match the OpenAI Agents SDK unless tests prove it.

`anthropic_messages`, `google_generative`, `bedrock_converse`

- Appear in the catalog as planned/disabled.
- They become selectable only after dedicated adapters handle streaming,
  usage, tool calls, approvals, and recovery semantics.

## Fallback Rules

Fallbacks are explicit per-agent configuration, not global magic.

- A missing or expired `openai-codex` token should not silently switch to
  `openai` API key unless the agent configured `openai/...` as a fallback.
- Provider auth failures should mark that provider attempt as failed and move
  to the next configured fallback.
- Provider capability mismatch, such as tools requested on a provider without
  supported tool calling, should fail that attempt with a clear diagnostic.
- Run logs should show which fallback index was used.

## API Surface

Add gateway routes:

- `GET /v1/model-providers`
- `POST /v1/model-providers`
- `PATCH /v1/model-providers/:id`
- `DELETE /v1/model-providers/:id`
- `POST /v1/model-providers/:id/test`
- `POST /v1/model-providers/:id/refresh-models`
- `GET /v1/models`
- `GET /v1/auth-profiles`
- `POST /v1/auth-profiles`
- `DELETE /v1/auth-profiles/:id`

Deleting a built-in provider should disable it rather than remove its seed row.
Deleting a custom provider can remove it if no agent references it.

## UI Scope

Settings gets a "Model Providers" surface:

- Provider list with enabled state, auth state, model count, base URL, and last
  test result.
- Provider detail form for base URL, auth profile, headers, model list, test
  connection, and refresh models.
- Custom provider creation for `openai_compatible`.

Agent create/edit gets a provider/model picker:

- Search models by provider and model name.
- Show capability chips: tools, vision, reasoning, streaming usage.
- Edit primary and fallback models.
- Preserve old agent display by mapping legacy model strings into a primary
  model reference.

Run logs should show the resolved provider/model instead of a bare model string
when the data is available.

## Migration

Add migrations:

- `model_providers`
- `model_definitions`
- `model_auth_profiles`
- `agents.model_config_json`
- run recovery metadata compatibility for legacy `providerKind`

Migration rules:

- Existing agents with a model like `gpt-5.4` become
  `{ primary: "openai-codex/gpt-5.4" }` when Codex is the configured default.
- Existing `OPENAI_API_KEY` env behavior maps to the built-in `openai` provider
  with an implicit env-backed auth profile.
- Existing Codex auth maps to `openai-codex`.
- Existing recovery states with `providerKind: "codex"` or `"api_key"` continue
  to resume through the legacy mapping.

## Error Handling

Configuration failures should be user-visible but not crash the gateway.

- Missing auth returns a final assistant message that names the provider and
  setup action.
- Unsupported provider API returns a clear provider configuration error.
- Expired OAuth/token auth returns a provider-specific re-auth message.
- Refresh-model failures update provider status and are visible in Settings.
- Runtime fallback attempts are recorded in run logs.

## Testing And Harness

Add tests before implementation:

- Protocol tests for provider/model/auth profile schemas.
- Migration and store tests for provider catalog, auth profiles, and agent model
  config compatibility.
- Resolver tests for primary success, fallback success, missing auth, expired
  Codex token, unsupported provider API, and "no implicit paid fallback".
- Adapter tests that assert base URL, headers, API key, and model id are passed
  into the OpenAI SDK client per run.
- UI tests for provider list/detail, custom provider creation, and agent model
  picker/fallbacks.
- Runtime harness scenario for a configured model provider.
- Acceptance scenario for creating a provider, selecting it on an agent, and
  seeing resolved provider/model in run logs.

## Acceptance Criteria

- Agents can store and edit primary/fallback model references.
- Built-in OpenAI-compatible providers can be configured from Settings.
- Runs resolve provider/model through `ModelRuntimeResolver`, not fixed global
  priority.
- ChatGPT/Codex and OpenAI API key behavior continue to work through provider
  records.
- No provider fallback happens unless explicitly configured by the agent.
- Run recovery and run logs record the resolved provider/model.
- Anthropic/Gemini/Bedrock are visible only as planned/disabled until adapters
  exist.
- Existing protocol, gateway, desktop UI, OpenAPI, and harness tests remain
  green.

