# Model Settings Provider/Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Vulture's split OpenAI/Codex model settings with an OpenClaw-compatible `provider/model` plus auth-profile architecture that also runs Anthropic through a native Messages adapter.

**Architecture:** Add shared protocol types and model-ref parsing first, then expose backend catalog/auth status, then replace `makeLazyLlm` with a resolver that builds a per-run Agents SDK `ModelProvider`. Settings UI reads backend catalog/status instead of the static provider list, while existing OpenAI API key and Codex OAuth behavior remain working through compatibility projections.

**Tech Stack:** TypeScript, React, Bun test, Hono gateway routes, Rust/Tauri shell auth bridge, OpenAI Agents SDK `Runner`/`ModelProvider`, OpenAI JS SDK, Anthropic Messages HTTP API.

---

## File Structure

- `packages/protocol/src/v1/modelConfig.ts`: shared model config, auth profile, status, and parser wire types.
- `packages/protocol/src/v1/modelConfig.test.ts`: parser and schema coverage for `provider/model@profile`.
- `packages/protocol/src/index.ts`: re-export new protocol module.
- `apps/desktop-shell/src/model_auth.rs`: project existing Codex OAuth store into a generic OpenAI auth profile.
- `apps/desktop-shell/src/tool_callback/model_auth_routes.rs`: authenticated shell callback routes for gateway credential/status reads.
- `apps/desktop-shell/src/tool_callback/mod.rs`: mount model auth callback routes.
- `apps/desktop-shell/src/main.rs`, `apps/desktop-shell/src/lib.rs`: register the new Rust module.
- `apps/gateway/src/domain/modelCatalog.ts`: backend-owned OpenClaw-compatible provider/model catalog.
- `apps/gateway/src/domain/modelAuth.ts`: gateway helper for reading shell-projected auth profiles and resolving provider order.
- `apps/gateway/src/routes/modelSettings.ts`: HTTP endpoints for model catalog/status/order updates.
- `apps/gateway/src/server.ts`: mount model settings routes and wire resolver dependencies.
- `apps/gateway/src/runtime/modelRef.ts`: gateway-facing parser wrapper around protocol helpers.
- `apps/gateway/src/runtime/modelProviderResolver.ts`: resolve `modelRef + auth profile` into concrete SDK model provider options.
- `apps/gateway/src/runtime/anthropicModelProvider.ts`: native Anthropic Messages `ModelProvider`.
- `apps/gateway/src/runtime/resolveLlm.ts`: delegate to the new resolver instead of hardcoded Codex/OpenAI/stub order.
- `apps/gateway/src/runtime/*.test.ts`: resolver, Anthropic adapter, and regression tests.
- `apps/desktop-ui/src/api/modelSettings.ts`: client API for catalog/status/order.
- `apps/desktop-ui/src/chat/Settings/ModelSection.tsx`: render provider catalog and auth profiles from backend data.
- `apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx`: model picker displays `provider/model` and auth profile choices.
- `apps/desktop-ui/src/chat/Settings/providerCatalog.ts`: shrink to temporary fallback helpers or remove from live path after UI migration.
- `apps/desktop-ui/src/chat/SettingsPage.test.tsx`, `apps/desktop-ui/src/chat/AgentEditModal.test.tsx`: UI coverage.

---

### Task 1: Shared Model/Auth Protocol and Model Ref Parser

**Files:**
- Create: `packages/protocol/src/v1/modelConfig.ts`
- Create: `packages/protocol/src/v1/modelConfig.test.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing parser/schema tests**

Create `packages/protocol/src/v1/modelConfig.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  ModelSettingsResponseSchema,
  parseModelRefWithProfile,
} from "./modelConfig";

describe("parseModelRefWithProfile", () => {
  test("parses provider model and trailing profile", () => {
    expect(parseModelRefWithProfile("openai/gpt-5.5@codex")).toEqual({
      raw: "openai/gpt-5.5@codex",
      modelRef: "openai/gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      profileId: "codex",
      explicitProfile: true,
    });
  });

  test("keeps date suffix as part of model id", () => {
    expect(parseModelRefWithProfile("anthropic/claude-sonnet@20251001")).toMatchObject({
      modelRef: "anthropic/claude-sonnet@20251001",
      model: "claude-sonnet@20251001",
      profileId: undefined,
      explicitProfile: false,
    });
    expect(parseModelRefWithProfile("anthropic/claude-sonnet@20251001@work")).toMatchObject({
      modelRef: "anthropic/claude-sonnet@20251001",
      model: "claude-sonnet@20251001",
      profileId: "work",
      explicitProfile: true,
    });
  });

  test("keeps local quant suffix as part of model id", () => {
    expect(parseModelRefWithProfile("ollama/gemma@q8_0")).toMatchObject({
      modelRef: "ollama/gemma@q8_0",
      model: "gemma@q8_0",
      profileId: undefined,
      explicitProfile: false,
    });
    expect(parseModelRefWithProfile("ollama/gemma@q8_0@lab")).toMatchObject({
      modelRef: "ollama/gemma@q8_0",
      model: "gemma@q8_0",
      profileId: "lab",
      explicitProfile: true,
    });
  });

  test("defaults bare model to openai for legacy compatibility", () => {
    expect(parseModelRefWithProfile("gpt-5.4")).toMatchObject({
      modelRef: "openai/gpt-5.4",
      provider: "openai",
      model: "gpt-5.4",
    });
  });
});

describe("ModelSettingsResponseSchema", () => {
  test("accepts catalog status and auth profile order", () => {
    const parsed = ModelSettingsResponseSchema.parse({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          auth: "api-key",
          models: [
            {
              id: "gpt-5.5",
              modelRef: "openai/gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text", "image"],
            },
          ],
          authProfiles: [
            {
              id: "codex",
              provider: "openai",
              mode: "oauth",
              label: "ChatGPT / Codex",
              status: "configured",
              email: "dev@example.com",
            },
          ],
          authOrder: ["codex"],
        },
      ],
    });
    expect(parsed.providers[0].models[0].modelRef).toBe("openai/gpt-5.5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/src/v1/modelConfig.test.ts`

Expected: fail because `./modelConfig` does not exist.

- [ ] **Step 3: Add protocol types and parser**

Create `packages/protocol/src/v1/modelConfig.ts`:

```ts
import { z } from "zod";

export const ModelApiSchema = z.enum([
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
]);
export type ModelApi = z.infer<typeof ModelApiSchema>;

export const ModelProviderAuthModeSchema = z.enum(["api-key", "oauth", "token", "none"]);
export type ModelProviderAuthMode = z.infer<typeof ModelProviderAuthModeSchema>;

export const ModelInputTypeSchema = z.enum(["text", "image", "audio", "video", "document"]);
export type ModelInputType = z.infer<typeof ModelInputTypeSchema>;

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  modelRef: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean(),
  input: z.array(ModelInputTypeSchema),
  contextWindow: z.number().positive().optional(),
  maxTokens: z.number().positive().optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const AuthProfileModeSchema = z.enum(["api_key", "oauth", "token", "none"]);
export type AuthProfileMode = z.infer<typeof AuthProfileModeSchema>;

export const AuthProfileStatusSchema = z.enum([
  "configured",
  "missing",
  "expired",
  "error",
  "unsupported",
]);
export type AuthProfileStatus = z.infer<typeof AuthProfileStatusSchema>;

export const AuthProfileViewSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  mode: AuthProfileModeSchema,
  label: z.string().min(1),
  status: AuthProfileStatusSchema,
  email: z.string().optional(),
  expiresAt: z.number().optional(),
  message: z.string().optional(),
});
export type AuthProfileView = z.infer<typeof AuthProfileViewSchema>;

export const ModelProviderViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().optional(),
  api: ModelApiSchema.optional(),
  auth: ModelProviderAuthModeSchema.optional(),
  models: z.array(ModelCatalogEntrySchema),
  authProfiles: z.array(AuthProfileViewSchema),
  authOrder: z.array(z.string()),
});
export type ModelProviderView = z.infer<typeof ModelProviderViewSchema>;

export const ModelSettingsResponseSchema = z.object({
  providers: z.array(ModelProviderViewSchema),
});
export type ModelSettingsResponse = z.infer<typeof ModelSettingsResponseSchema>;

export const UpdateModelAuthOrderSchema = z.object({
  provider: z.string().min(1),
  authOrder: z.array(z.string().min(1)),
});
export type UpdateModelAuthOrder = z.infer<typeof UpdateModelAuthOrderSchema>;

export interface ParsedModelRef {
  raw: string;
  modelRef: string;
  provider: string;
  model: string;
  profileId?: string;
  explicitProfile: boolean;
}

export function parseModelRefWithProfile(
  raw: string,
  defaultProvider = "openai",
): ParsedModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const { model: modelPart, profile } = splitTrailingAuthProfile(trimmed);
  const slash = modelPart.indexOf("/");
  const provider = slash === -1 ? defaultProvider : modelPart.slice(0, slash).trim();
  const model = slash === -1 ? modelPart : modelPart.slice(slash + 1).trim();
  if (!provider || !model) return null;
  const modelRef = `${provider}/${model}`;
  return {
    raw: trimmed,
    modelRef,
    provider,
    model,
    profileId: profile,
    explicitProfile: Boolean(profile),
  };
}

export function splitTrailingAuthProfile(raw: string): { model: string; profile?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { model: "" };
  const lastSlash = trimmed.lastIndexOf("/");
  let delimiter = trimmed.indexOf("@", lastSlash + 1);
  if (delimiter <= 0) return { model: trimmed };
  const suffixAfterDelimiter = () => trimmed.slice(delimiter + 1);
  if (/^\d{8}(?:@|$)/.test(suffixAfterDelimiter())) {
    const next = trimmed.indexOf("@", delimiter + 9);
    if (next < 0) return { model: trimmed };
    delimiter = next;
  }
  if (/^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i.test(suffixAfterDelimiter())) {
    const next = trimmed.indexOf("@", delimiter + 1);
    if (next < 0) return { model: trimmed };
    delimiter = next;
  }
  const model = trimmed.slice(0, delimiter).trim();
  const profile = trimmed.slice(delimiter + 1).trim();
  if (!model || !profile) return { model: trimmed };
  return { model, profile };
}
```

Modify `packages/protocol/src/index.ts`:

```ts
export * from "./v1/modelConfig";
```

Keep the existing exports in `packages/protocol/src/index.ts`; append this export rather than replacing the file.

- [ ] **Step 4: Run protocol tests**

Run: `bun test packages/protocol/src/v1/modelConfig.test.ts`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/v1/modelConfig.ts packages/protocol/src/v1/modelConfig.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add model auth settings contract"
```

---

### Task 2: Shell Codex Auth Projection

**Files:**
- Create: `apps/desktop-shell/src/model_auth.rs`
- Create: `apps/desktop-shell/src/tool_callback/model_auth_routes.rs`
- Modify: `apps/desktop-shell/src/tool_callback/mod.rs`
- Modify: `apps/desktop-shell/src/main.rs`
- Modify: `apps/desktop-shell/src/lib.rs`

- [ ] **Step 1: Write Rust tests for projected Codex profile**

Add tests at the bottom of `apps/desktop-shell/src/model_auth.rs` after creating the file in Step 3:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_auth::CodexCreds;

    #[test]
    fn projects_codex_as_openai_oauth_profile() {
        let now = 1_700_000_000_000;
        let profiles = project_model_auth_profiles(
            Some(CodexCreds {
                access_token: "access".into(),
                refresh_token: "refresh".into(),
                id_token: "id".into(),
                account_id: "acct".into(),
                email: Some("dev@example.com".into()),
                expires_at: now + 60_000,
                stored_at: now,
                imported_from: None,
            }),
            now,
        );

        assert_eq!(profiles.auth_order.get("openai").unwrap(), &vec!["codex".to_string()]);
        assert_eq!(profiles.profiles[0].id, "codex");
        assert_eq!(profiles.profiles[0].provider, "openai");
        assert_eq!(profiles.profiles[0].mode, "oauth");
        assert_eq!(profiles.profiles[0].status, "configured");
    }

    #[test]
    fn marks_expired_codex_profile() {
        let now = 1_700_000_000_000;
        let profiles = project_model_auth_profiles(
            Some(CodexCreds {
                access_token: "access".into(),
                refresh_token: "refresh".into(),
                id_token: "id".into(),
                account_id: "acct".into(),
                email: None,
                expires_at: now - 1,
                stored_at: now - 60_000,
                imported_from: None,
            }),
            now,
        );
        assert_eq!(profiles.profiles[0].status, "expired");
    }
}
```

- [ ] **Step 2: Run Rust test to verify it fails**

Run: `cargo test -p desktop-shell model_auth`

Expected: fail because `model_auth.rs` does not exist or exported symbols are missing.

- [ ] **Step 3: Implement Codex projection structs and helper**

Create `apps/desktop-shell/src/model_auth.rs`:

```rust
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::codex_auth::CodexCreds;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelAuthProfileView {
    pub id: String,
    pub provider: String,
    pub mode: String,
    pub label: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelAuthProfilesResponse {
    pub profiles: Vec<ModelAuthProfileView>,
    pub auth_order: BTreeMap<String, Vec<String>>,
}

pub fn project_model_auth_profiles(
    codex: Option<CodexCreds>,
    now_ms: u64,
) -> ModelAuthProfilesResponse {
    let mut profiles = Vec::new();
    let mut openai_order = Vec::new();

    if let Some(creds) = codex {
        openai_order.push("codex".to_string());
        profiles.push(ModelAuthProfileView {
            id: "codex".into(),
            provider: "openai".into(),
            mode: "oauth".into(),
            label: "ChatGPT / Codex".into(),
            status: if creds.expires_at <= now_ms { "expired" } else { "configured" }.into(),
            email: creds.email,
            expires_at: Some(creds.expires_at),
            source: creds.imported_from,
        });
    }

    let mut auth_order = BTreeMap::new();
    if !openai_order.is_empty() {
        auth_order.insert("openai".to_string(), openai_order);
    }

    ModelAuthProfilesResponse { profiles, auth_order }
}
```

- [ ] **Step 4: Add shell callback routes**

Create `apps/desktop-shell/src/tool_callback/model_auth_routes.rs`:

```rust
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{extract::State, response::IntoResponse, Json};

use crate::codex_auth::{read_store, unix_now_ms};
use crate::model_auth::{project_model_auth_profiles, ModelAuthProfilesResponse};

#[derive(Clone)]
pub struct ModelAuthState {
    pub profile_dir: Arc<RwLock<PathBuf>>,
}

pub async fn model_auth_profiles_handler(
    State(state): State<ModelAuthState>,
) -> impl IntoResponse {
    let profile_dir = state.profile_dir.read().expect("profile_dir lock poisoned").clone();
    let codex = read_store(&profile_dir).ok().flatten();
    let response: ModelAuthProfilesResponse = project_model_auth_profiles(codex, unix_now_ms());
    Json(response)
}
```

- [ ] **Step 5: Mount the route in the callback server**

Modify `apps/desktop-shell/src/tool_callback/mod.rs`:

```rust
mod model_auth_routes;
use model_auth_routes::{model_auth_profiles_handler, ModelAuthState};
```

Inside `build_router`, before the public `/healthz` router, add:

```rust
let model_auth_router = Router::new()
    .route("/auth/model-profiles", get(model_auth_profiles_handler))
    .route_layer(middleware::from_fn_with_state(
        state.clone(),
        auth_middleware,
    ))
    .with_state(ModelAuthState {
        profile_dir: codex_state.profile_dir.clone(),
    });
```

Merge it beside the existing Codex auth router:

```rust
.merge(model_auth_router)
```

- [ ] **Step 6: Register Rust module exports**

Modify `apps/desktop-shell/src/main.rs`:

```rust
mod model_auth;
```

Modify `apps/desktop-shell/src/lib.rs`:

```rust
pub mod model_auth;
```

- [ ] **Step 7: Run shell tests**

Run: `cargo test -p desktop-shell model_auth`

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop-shell/src/model_auth.rs apps/desktop-shell/src/tool_callback/model_auth_routes.rs apps/desktop-shell/src/tool_callback/mod.rs apps/desktop-shell/src/main.rs apps/desktop-shell/src/lib.rs
git commit -m "feat(shell): project model auth profiles"
```

---

### Task 3: Gateway Catalog and Model Settings Routes

**Files:**
- Create: `apps/gateway/src/domain/modelCatalog.ts`
- Create: `apps/gateway/src/domain/modelAuth.ts`
- Create: `apps/gateway/src/routes/modelSettings.ts`
- Create: `apps/gateway/src/routes/modelSettings.test.ts`
- Modify: `apps/gateway/src/server.ts`

- [ ] **Step 1: Write route tests**

Create `apps/gateway/src/routes/modelSettings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { modelSettingsRouter } from "./modelSettings";

describe("modelSettingsRouter", () => {
  test("returns OpenAI as one provider with API key and Codex profiles", async () => {
    const app = new Hono();
    app.route("/v1/model-settings", modelSettingsRouter({
      shellCallbackUrl: "http://shell",
      shellToken: "bearer",
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: async (url) => {
        expect(String(url)).toBe("http://shell/auth/model-profiles");
        return new Response(JSON.stringify({
          profiles: [
            {
              id: "codex",
              provider: "openai",
              mode: "oauth",
              label: "ChatGPT / Codex",
              status: "configured",
              email: "dev@example.com",
            },
          ],
          auth_order: { openai: ["codex"] },
        }), { status: 200 });
      },
    }));

    const res = await app.request("/v1/model-settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    const openai = body.providers.find((p: { id: string }) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai.authProfiles.map((p: { id: string }) => p.id)).toEqual([
      "codex",
      "openai-api-key",
    ]);
    expect(body.providers.some((p: { id: string }) => p.id === "gateway")).toBe(false);
  });
});
```

- [ ] **Step 2: Run route test to verify it fails**

Run: `bun test apps/gateway/src/routes/modelSettings.test.ts`

Expected: fail because `modelSettingsRouter` does not exist.

- [ ] **Step 3: Add static backend catalog**

Create `apps/gateway/src/domain/modelCatalog.ts`:

```ts
import type { ModelProviderView } from "@vulture/protocol/src/v1/modelConfig";

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
        model("openai", "gpt-5.4-mini", "GPT-5.4 mini", true, ["text", "image"]),
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
        model("anthropic", "claude-sonnet-4.5", "Claude Sonnet 4.5", true, ["text", "image"]),
        model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", false, ["text", "image"]),
        model("anthropic", "claude-opus-4", "Claude Opus 4", true, ["text", "image"]),
      ],
      authProfiles: [
        {
          id: "anthropic-api-key",
          provider: "anthropic",
          mode: "api_key",
          label: "Anthropic API Key",
          status: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
        },
        {
          id: "anthropic-oauth",
          provider: "anthropic",
          mode: "oauth",
          label: "Claude OAuth",
          status: "unsupported",
          message: "Claude OAuth UI is not connected in this build.",
        },
      ],
      authOrder: ["anthropic-api-key"],
    },
  ];
}

function model(
  provider: string,
  id: string,
  name: string,
  reasoning: boolean,
  input: Array<"text" | "image" | "audio" | "video" | "document">,
) {
  return { id, modelRef: `${provider}/${id}`, name, reasoning, input };
}
```

- [ ] **Step 4: Add shell auth read helper**

Create `apps/gateway/src/domain/modelAuth.ts`:

```ts
import type { AuthProfileView } from "@vulture/protocol/src/v1/modelConfig";

interface ShellProfilesResponse {
  profiles?: Array<{
    id: string;
    provider: string;
    mode: "api_key" | "oauth" | "token" | "none";
    label: string;
    status: "configured" | "missing" | "expired" | "error" | "unsupported";
    email?: string;
    expires_at?: number;
    source?: string;
    message?: string;
  }>;
  auth_order?: Record<string, string[]>;
}

export interface ModelAuthSnapshot {
  profiles: AuthProfileView[];
  authOrder: Record<string, string[]>;
}

export async function fetchShellModelAuthSnapshot(opts: {
  shellCallbackUrl: string;
  shellToken: string;
  fetch?: typeof fetch;
}): Promise<ModelAuthSnapshot> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${opts.shellCallbackUrl}/auth/model-profiles`, {
    headers: { Authorization: `Bearer ${opts.shellToken}` },
  });
  if (!res.ok) return { profiles: [], authOrder: {} };
  const raw = (await res.json()) as ShellProfilesResponse;
  return {
    profiles: (raw.profiles ?? []).map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      mode: profile.mode,
      label: profile.label,
      status: profile.status,
      email: profile.email,
      expiresAt: profile.expires_at,
      message: profile.message,
    })),
    authOrder: raw.auth_order ?? {},
  };
}
```

- [ ] **Step 5: Add model settings router**

Create `apps/gateway/src/routes/modelSettings.ts`:

```ts
import { Hono } from "hono";
import { ModelSettingsResponseSchema } from "@vulture/protocol/src/v1/modelConfig";
import { baseModelProviders } from "../domain/modelCatalog";
import { fetchShellModelAuthSnapshot } from "../domain/modelAuth";

export function modelSettingsRouter(deps: {
  shellCallbackUrl: string;
  shellToken: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const [shellAuth] = await Promise.all([
      fetchShellModelAuthSnapshot({
        shellCallbackUrl: deps.shellCallbackUrl,
        shellToken: deps.shellToken,
        fetch: deps.fetch,
      }),
    ]);
    const env = deps.env ?? process.env;
    const envProfiles = env.OPENAI_API_KEY
      ? [{
          id: "openai-api-key",
          provider: "openai",
          mode: "api_key" as const,
          label: "OpenAI API Key",
          status: "configured" as const,
        }]
      : [];
    const allProfiles = [...shellAuth.profiles, ...envProfiles];
    const providers = baseModelProviders().map((provider) => {
      const authProfiles = [
        ...allProfiles.filter((profile) => profile.provider === provider.id),
        ...provider.authProfiles.filter(
          (profile) => !allProfiles.some((existing) => existing.id === profile.id),
        ),
      ];
      const authOrder = shellAuth.authOrder[provider.id] ?? provider.authOrder;
      return {
        ...provider,
        authProfiles,
        authOrder: provider.id === "openai" && env.OPENAI_API_KEY && !authOrder.includes("openai-api-key")
          ? [...authOrder, "openai-api-key"]
          : authOrder,
      };
    });
    return c.json(ModelSettingsResponseSchema.parse({ providers }));
  });

  return app;
}
```

- [ ] **Step 6: Mount route in gateway server**

Modify `apps/gateway/src/server.ts` imports:

```ts
import { modelSettingsRouter } from "./routes/modelSettings";
```

Mount near other `/v1/*` routes:

```ts
app.route("/v1/model-settings", modelSettingsRouter({
  shellCallbackUrl: cfg.shellCallbackUrl,
  shellToken: cfg.token,
  env: process.env,
}));
```

- [ ] **Step 7: Run gateway route test**

Run: `bun test apps/gateway/src/routes/modelSettings.test.ts`

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/domain/modelCatalog.ts apps/gateway/src/domain/modelAuth.ts apps/gateway/src/routes/modelSettings.ts apps/gateway/src/routes/modelSettings.test.ts apps/gateway/src/server.ts
git commit -m "feat(gateway): expose model settings catalog"
```

---

### Task 4: Gateway Runtime Provider Resolver

**Files:**
- Create: `apps/gateway/src/runtime/modelRef.ts`
- Create: `apps/gateway/src/runtime/modelProviderResolver.ts`
- Create: `apps/gateway/src/runtime/modelProviderResolver.test.ts`
- Modify: `apps/gateway/src/runtime/resolveLlm.ts`
- Modify: `apps/gateway/src/runtime/codexLlm.ts`

- [ ] **Step 1: Write resolver tests**

Create `apps/gateway/src/runtime/modelProviderResolver.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveRuntimeModelProvider } from "./modelProviderResolver";

describe("resolveRuntimeModelProvider", () => {
  test("uses explicit Codex profile without falling back to API key when expired", async () => {
    const resolved = await resolveRuntimeModelProvider({
      model: "openai/gpt-5.5@codex",
      shellCallbackUrl: "http://shell",
      shellToken: "token",
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: async (url) => {
        if (String(url).endsWith("/auth/model-profiles")) {
          return new Response(JSON.stringify({
            profiles: [
              { id: "codex", provider: "openai", mode: "oauth", label: "Codex", status: "expired" },
              { id: "openai-api-key", provider: "openai", mode: "api_key", label: "OpenAI API Key", status: "configured" },
            ],
            auth_order: { openai: ["codex", "openai-api-key"] },
          }), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      },
    });
    expect(resolved.kind).toBe("error");
    if (resolved.kind === "error") {
      expect(resolved.message).toContain("codex");
      expect(resolved.provider).toBe("openai");
    }
  });

  test("uses OpenAI API key profile when no explicit profile is set", async () => {
    const resolved = await resolveRuntimeModelProvider({
      model: "openai/gpt-5.5",
      shellCallbackUrl: "http://shell",
      shellToken: "token",
      env: { OPENAI_API_KEY: "sk-test" },
      fetch: async () => new Response(JSON.stringify({
        profiles: [{ id: "openai-api-key", provider: "openai", mode: "api_key", label: "OpenAI API Key", status: "configured" }],
        auth_order: { openai: ["openai-api-key"] },
      }), { status: 200 }),
    });
    expect(resolved.kind).toBe("provider");
    if (resolved.kind === "provider") {
      expect(resolved.provider).toBe("openai");
      expect(resolved.model).toBe("gpt-5.5");
      expect(resolved.profileId).toBe("openai-api-key");
    }
  });

  test("returns provider-specific missing auth message", async () => {
    const resolved = await resolveRuntimeModelProvider({
      model: "anthropic/claude-sonnet-4.5",
      shellCallbackUrl: "http://shell",
      shellToken: "token",
      env: {},
      fetch: async () => new Response(JSON.stringify({ profiles: [], auth_order: {} }), { status: 200 }),
    });
    expect(resolved.kind).toBe("error");
    if (resolved.kind === "error") {
      expect(resolved.message).toContain("Anthropic");
      expect(resolved.message).not.toContain("OPENAI_API_KEY");
    }
  });
});
```

- [ ] **Step 2: Run resolver test to verify it fails**

Run: `bun test apps/gateway/src/runtime/modelProviderResolver.test.ts`

Expected: fail because resolver module does not exist.

- [ ] **Step 3: Add model ref wrapper**

Create `apps/gateway/src/runtime/modelRef.ts`:

```ts
export {
  parseModelRefWithProfile,
  splitTrailingAuthProfile,
  type ParsedModelRef,
} from "@vulture/protocol/src/v1/modelConfig";
```

- [ ] **Step 4: Add resolver implementation**

Create `apps/gateway/src/runtime/modelProviderResolver.ts`:

```ts
import type { ModelProvider } from "@openai/agents";
import type { AuthProfileView } from "@vulture/protocol/src/v1/modelConfig";
import { fetchShellModelAuthSnapshot } from "../domain/modelAuth";
import { parseModelRefWithProfile } from "./modelRef";
import { makeCodexModelProvider } from "./codexLlm";
import { makeResponsesModelProvider } from "./openaiLlm";
import { makeAnthropicModelProvider } from "./anthropicModelProvider";

export type ResolvedRuntimeModelProvider =
  | {
      kind: "provider";
      provider: string;
      model: string;
      profileId: string;
      modelProvider: ModelProvider;
      credentialKind: "api_key" | "oauth" | "token" | "none";
    }
  | {
      kind: "error";
      provider: string;
      model: string;
      profileId?: string;
      message: string;
    };

export async function resolveRuntimeModelProvider(opts: {
  model: string;
  shellCallbackUrl: string;
  shellToken: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): Promise<ResolvedRuntimeModelProvider> {
  const parsed = parseModelRefWithProfile(opts.model);
  if (!parsed) {
    return { kind: "error", provider: "unknown", model: opts.model, message: `Invalid model: ${opts.model}` };
  }
  const env = opts.env ?? process.env;
  const shellAuth = await fetchShellModelAuthSnapshot({
    shellCallbackUrl: opts.shellCallbackUrl,
    shellToken: opts.shellToken,
    fetch: opts.fetch,
  });
  const profiles = profilesForProvider(parsed.provider, shellAuth.profiles, env);
  const ordered = orderProfiles(parsed.provider, profiles, shellAuth.authOrder[parsed.provider]);
  const candidates = parsed.profileId
    ? ordered.filter((profile) => profile.id === parsed.profileId)
    : ordered;
  if (parsed.profileId && candidates.length === 0) {
    return {
      kind: "error",
      provider: parsed.provider,
      model: parsed.model,
      profileId: parsed.profileId,
      message: `No auth profile '${parsed.profileId}' is configured for ${displayProvider(parsed.provider)}.`,
    };
  }
  for (const profile of candidates) {
    if (profile.status !== "configured") {
      if (parsed.explicitProfile) {
        return {
          kind: "error",
          provider: parsed.provider,
          model: parsed.model,
          profileId: profile.id,
          message: `${displayProvider(parsed.provider)} profile '${profile.id}' is ${profile.status}.`,
        };
      }
      continue;
    }
    if (parsed.provider === "openai" && profile.id === "codex" && profile.mode === "oauth") {
      const modelProvider = await makeCodexModelProvider({
        shellUrl: opts.shellCallbackUrl,
        shellBearer: opts.shellToken,
        fetch: opts.fetch,
      });
      return provider(parsed.provider, parsed.model, profile.id, "oauth", modelProvider);
    }
    if (parsed.provider === "openai" && profile.mode === "api_key") {
      const apiKey = env.OPENAI_API_KEY;
      if (!apiKey) continue;
      return provider(parsed.provider, parsed.model, profile.id, "api_key", makeResponsesModelProvider({ apiKey }));
    }
    if (parsed.provider === "anthropic" && profile.mode === "api_key") {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) continue;
      return provider(parsed.provider, parsed.model, profile.id, "api_key", makeAnthropicModelProvider({ apiKey }));
    }
  }
  return {
    kind: "error",
    provider: parsed.provider,
    model: parsed.model,
    message: `${displayProvider(parsed.provider)} has no configured connection method for ${parsed.model}.`,
  };
}

function profilesForProvider(
  provider: string,
  shellProfiles: AuthProfileView[],
  env: Record<string, string | undefined>,
): AuthProfileView[] {
  const profiles = shellProfiles.filter((profile) => profile.provider === provider);
  if (provider === "anthropic") {
    profiles.push({
      id: "anthropic-api-key",
      provider,
      mode: "api_key",
      label: "Anthropic API Key",
      status: env.ANTHROPIC_API_KEY ? "configured" : "missing",
    });
  }
  return profiles;
}

function orderProfiles(provider: string, profiles: AuthProfileView[], order?: string[]): AuthProfileView[] {
  if (!order || order.length === 0) return profiles;
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return [
    ...order.map((id) => byId.get(id)).filter((profile): profile is AuthProfileView => Boolean(profile)),
    ...profiles.filter((profile) => !order.includes(profile.id)),
  ];
}

function provider(
  providerName: string,
  model: string,
  profileId: string,
  credentialKind: "api_key" | "oauth" | "token" | "none",
  modelProvider: ModelProvider,
): ResolvedRuntimeModelProvider {
  return { kind: "provider", provider: providerName, model, profileId, credentialKind, modelProvider };
}

function displayProvider(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  return provider;
}
```

This references `makeAnthropicModelProvider`, which Task 5 implements. Run the Task 4 focused resolver tests before whole-app gateway typecheck, then complete Task 5 before running gateway typecheck.

- [ ] **Step 5: Extract Codex model provider factory**

Modify `apps/gateway/src/runtime/codexLlm.ts` by adding:

```ts
import type { ModelProvider } from "@openai/agents";

export async function makeCodexModelProvider(opts: {
  shellUrl: string;
  shellBearer: string;
  fetch?: typeof fetch;
  codexToken?: CodexShellResponse;
}): Promise<ModelProvider> {
  const token =
    opts.codexToken ??
    (await fetchCodexToken({
      shellUrl: opts.shellUrl,
      bearer: opts.shellBearer,
      fetch: opts.fetch,
    }));
  const client = new OpenAI({
    apiKey: token.accessToken,
    baseURL: "https://chatgpt.com/backend-api/codex",
    defaultHeaders: {
      "OpenAI-Beta": "responses=experimental",
      "chatgpt-account-id": token.accountId,
      originator: "codex_cli_rs",
    },
    fetch: makeCodexResponsesFetch(opts.fetch),
    dangerouslyAllowBrowser: true,
  });
  return makeResponsesModelProvider({ openAIClient: client });
}
```

Then update `makeCodexLlm` to call this helper and pass the returned provider into `makeOpenAILlm`.

- [ ] **Step 6: Wire resolver into `makeLazyLlm`**

Modify `apps/gateway/src/runtime/resolveLlm.ts` so the async generator first calls `resolveRuntimeModelProvider`. Replace the current hardcoded Codex/OpenAI/stub body with:

```ts
const resolved = await resolveRuntimeModelProvider({
  model: input.model,
  shellCallbackUrl: deps.shellCallbackUrl,
  shellToken: deps.shellToken,
  env: deps.env,
  fetch: deps.fetch,
});
if (resolved.kind === "error") {
  yield { kind: "final", text: resolved.message };
  return;
}
const inner = makeOpenAILlm({
  apiKey: "provider-owned",
  toolNames: deps.toolNames,
  toolCallable: deps.toolCallable,
  modelProvider: resolved.modelProvider,
  approvalCallable: deps.approvalCallable,
  mcpToolProvider: deps.mcpToolProvider,
  runFactory: deps.runFactory,
  runtimeHooks: deps.runtimeHooks,
});
yield* inner({ ...input, model: resolved.model });
```

Keep `makeStubLlmFallback` exported for older tests until all callers are updated.

- [ ] **Step 7: Run resolver tests**

Run: `bun test apps/gateway/src/runtime/modelProviderResolver.test.ts apps/gateway/src/runtime/resolveLlm.test.ts apps/gateway/src/runtime/codexLlm.ts`

Expected: resolver tests pass; existing `resolveLlm.test.ts` needs expectation updates from `OPENAI_API_KEY` generic text to provider-specific missing-auth text.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/runtime/modelRef.ts apps/gateway/src/runtime/modelProviderResolver.ts apps/gateway/src/runtime/modelProviderResolver.test.ts apps/gateway/src/runtime/resolveLlm.ts apps/gateway/src/runtime/codexLlm.ts
git commit -m "feat(gateway): resolve model auth profiles at runtime"
```

---

### Task 5: Native Anthropic Messages ModelProvider

**Files:**
- Create: `apps/gateway/src/runtime/anthropicModelProvider.ts`
- Create: `apps/gateway/src/runtime/anthropicModelProvider.test.ts`
- Modify: `apps/gateway/package.json`

- [ ] **Step 1: Write adapter tests with fake fetch**

Create `apps/gateway/src/runtime/anthropicModelProvider.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeAnthropicModelProvider } from "./anthropicModelProvider";

describe("makeAnthropicModelProvider", () => {
  test("streams text deltas and final response", async () => {
    const provider = makeAnthropicModelProvider({
      apiKey: "sk-ant-test",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("claude-sonnet-4.5");
        return new Response([
          "event: message_start",
          "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4.5\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}",
          "",
          "event: content_block_start",
          "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
          "",
          "event: content_block_delta",
          "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}",
          "",
          "event: message_delta",
          "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1},\"delta\":{\"stop_reason\":\"end_turn\"}}",
          "",
          "event: message_stop",
          "data: {\"type\":\"message_stop\"}",
          "",
        ].join("\\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const model = await provider.getModel("claude-sonnet-4.5");
    const events: string[] = [];
    for await (const event of model.getStreamedResponse({
      model: "claude-sonnet-4.5",
      system: "system",
      input: [{ role: "user", content: "hi" }],
      tools: [],
      modelSettings: {},
    } as never)) {
      events.push(JSON.stringify(event));
    }
    expect(events.join("\\n")).toContain("hello");
  });
});
```

- [ ] **Step 2: Run adapter test to verify it fails**

Run: `bun test apps/gateway/src/runtime/anthropicModelProvider.test.ts`

Expected: fail because module does not exist.

- [ ] **Step 3: Implement minimal Anthropic provider**

Create `apps/gateway/src/runtime/anthropicModelProvider.ts`:

```ts
import type { Model, ModelProvider, ModelRequest, ModelResponseStreamEvent } from "@openai/agents";

export function makeAnthropicModelProvider(opts: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): ModelProvider {
  return {
    getModel(modelName?: string): Promise<Model> {
      return Promise.resolve(new AnthropicMessagesModel({
        model: modelName ?? "claude-sonnet-4.5",
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl ?? "https://api.anthropic.com",
        fetch: opts.fetch ?? fetch,
      }));
    },
  };
}

class AnthropicMessagesModel implements Model {
  constructor(
    private readonly opts: {
      model: string;
      apiKey: string;
      baseUrl: string;
      fetch: typeof fetch;
    },
  ) {}

  async getResponse(request: ModelRequest): Promise<unknown> {
    let finalText = "";
    for await (const event of this.getStreamedResponse(request)) {
      const text = JSON.stringify(event);
      if (text.includes("text_delta")) finalText += text;
    }
    return { output: finalText };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ModelResponseStreamEvent> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(toAnthropicRequest(this.opts.model, request)),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Anthropic provider error: HTTP ${res.status}`);
    }
    for await (const event of parseAnthropicSse(res.body)) {
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        yield {
          type: "response.output_text.delta",
          delta: event.delta.text,
        } as ModelResponseStreamEvent;
      }
      if (event.type === "message_stop") {
        yield { type: "response.completed", response: { output: [] } } as ModelResponseStreamEvent;
      }
    }
  }
}

function toAnthropicRequest(model: string, request: ModelRequest): Record<string, unknown> {
  return {
    model,
    max_tokens: 4096,
    stream: true,
    system: typeof request.system === "string" ? request.system : undefined,
    messages: [{ role: "user", content: stringifyInput(request.input) }],
    tools: Array.isArray(request.tools) ? request.tools : [],
  };
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "content" in item) {
          const content = (item as { content?: unknown }).content;
          return typeof content === "string" ? content : JSON.stringify(content);
        }
        return JSON.stringify(item);
      })
      .join("\\n");
  }
  return JSON.stringify(input);
}

async function* parseAnthropicSse(body: ReadableStream<Uint8Array>): AsyncIterable<any> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\\n\\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\\n").find((line) => line.startsWith("data: "));
      if (data) yield JSON.parse(data.slice("data: ".length));
      boundary = buffer.indexOf("\\n\\n");
    }
  }
}
```

After this compiles, inspect the local `@openai/agents` model type and adjust emitted event shapes to the exact SDK types. Keep the test fake stream and expected text behavior unchanged.

- [ ] **Step 4: Keep dependency graph unchanged**

Do not add `@anthropic-ai/sdk` in this task. The first adapter uses direct HTTP fetch so the dependency graph stays unchanged.

- [ ] **Step 5: Run adapter and resolver tests**

Run: `bun test apps/gateway/src/runtime/anthropicModelProvider.test.ts apps/gateway/src/runtime/modelProviderResolver.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/runtime/anthropicModelProvider.ts apps/gateway/src/runtime/anthropicModelProvider.test.ts apps/gateway/package.json bun.lock
git commit -m "feat(gateway): add anthropic model provider"
```

If `package.json` and `bun.lock` did not change, omit them from `git add`.

---

### Task 6: Agent Model Migration and Picker Contract

**Files:**
- Create: `apps/gateway/src/domain/modelMigration.ts`
- Create: `apps/gateway/src/domain/modelMigration.test.ts`
- Modify: `apps/gateway/src/domain/agentStore.ts`
- Modify: `packages/protocol/src/v1/agent.ts`
- Modify: `apps/desktop-ui/src/api/agents.ts`

- [ ] **Step 1: Write migration tests**

Create `apps/gateway/src/domain/modelMigration.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizePersistedAgentModel } from "./modelMigration";

describe("normalizePersistedAgentModel", () => {
  test("prefixes known bare OpenAI models", () => {
    expect(normalizePersistedAgentModel("gpt-5.4")).toBe("openai/gpt-5.4");
    expect(normalizePersistedAgentModel("gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
  });

  test("keeps already qualified refs", () => {
    expect(normalizePersistedAgentModel("anthropic/claude-sonnet-4.5")).toBe("anthropic/claude-sonnet-4.5");
  });

  test("maps gateway auto to an explicit codex profile", () => {
    expect(normalizePersistedAgentModel("gateway/auto")).toBe("openai/gpt-5.5@codex");
  });

  test("preserves unknown legacy model values", () => {
    expect(normalizePersistedAgentModel("custom-model")).toBe("custom-model");
  });
});
```

- [ ] **Step 2: Run migration test to verify it fails**

Run: `bun test apps/gateway/src/domain/modelMigration.test.ts`

Expected: fail because helper does not exist.

- [ ] **Step 3: Implement migration helper**

Create `apps/gateway/src/domain/modelMigration.ts`:

```ts
const KNOWN_OPENAI_BARE = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "o3-mini",
]);

export function normalizePersistedAgentModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return model;
  if (trimmed.includes("/")) {
    if (trimmed === "gateway/auto") return "openai/gpt-5.5@codex";
    if (trimmed === "gateway/long-context") return "openai/gpt-5.5@codex";
    if (trimmed === "gateway/cheap") return "openai/gpt-5.4-mini@codex";
    return trimmed;
  }
  if (KNOWN_OPENAI_BARE.has(trimmed)) return `openai/${trimmed}`;
  return trimmed;
}
```

- [ ] **Step 4: Apply migration when reading and saving agents**

Modify `apps/gateway/src/domain/agentStore.ts`.

In `rowToAgent`, change:

```ts
model: r.model,
```

to:

```ts
model: normalizePersistedAgentModel(r.model),
```

Import the helper:

```ts
import { normalizePersistedAgentModel } from "./modelMigration";
```

In `_save`, normalize `req.model` before insert/update:

```ts
const normalizedModel = normalizePersistedAgentModel(req.model);
```

Use `normalizedModel` in the SQL parameter list wherever `req.model` is currently passed.

- [ ] **Step 5: Keep protocol model as string**

Do not make `AgentSchema.model` stricter than `z.string().min(1)` yet. Add this comment above the field in `packages/protocol/src/v1/agent.ts`:

```ts
// Model refs are normalized by the gateway to provider/model, but legacy and
// user-entered values remain strings so existing agents never become unreadable.
```

Update `apps/desktop-ui/src/api/agents.ts` comments on `model`:

```ts
/** Preferred shape is provider/model or provider/model@profile. */
model: string;
```

- [ ] **Step 6: Run agent tests**

Run: `bun test apps/gateway/src/domain/modelMigration.test.ts apps/gateway/src/routes/agents.test.ts apps/gateway/src/domain/agentStore.test.ts`

Expected: pass after updating expected default models from `gpt-5.4` to `openai/gpt-5.4` where tests assert exact model values.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/domain/modelMigration.ts apps/gateway/src/domain/modelMigration.test.ts apps/gateway/src/domain/agentStore.ts packages/protocol/src/v1/agent.ts apps/desktop-ui/src/api/agents.ts
git commit -m "feat(gateway): normalize agent model refs"
```

---

### Task 7: Settings UI from Backend Catalog

**Files:**
- Create: `apps/desktop-ui/src/api/modelSettings.ts`
- Modify: `apps/desktop-ui/src/chat/Settings/types.ts`
- Modify: `apps/desktop-ui/src/App.tsx`
- Modify: `apps/desktop-ui/src/chat/Settings/ModelSection.tsx`
- Modify: `apps/desktop-ui/src/chat/Settings/providerCatalog.ts`
- Modify: `apps/desktop-ui/src/chat/SettingsPage.test.tsx`

- [ ] **Step 1: Write UI test expectations**

Modify `apps/desktop-ui/src/chat/SettingsPage.test.tsx` in `SettingsPage Models`:

```ts
test("model tab groups Codex under OpenAI instead of a gateway provider", async () => {
  render(<SettingsPage {...props({
    onGetModelSettings: mock(async () => ({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          auth: "api-key",
          models: [
            { id: "gpt-5.5", modelRef: "openai/gpt-5.5", name: "GPT-5.5", reasoning: true, input: ["text"] },
          ],
          authProfiles: [
            { id: "codex", provider: "openai", mode: "oauth", label: "ChatGPT / Codex", status: "configured", email: "dev@example.com" },
            { id: "openai-api-key", provider: "openai", mode: "api_key", label: "OpenAI API Key", status: "configured" },
          ],
          authOrder: ["codex", "openai-api-key"],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          api: "anthropic-messages",
          models: [
            { id: "claude-sonnet-4.5", modelRef: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", reasoning: true, input: ["text"] },
          ],
          authProfiles: [
            { id: "anthropic-api-key", provider: "anthropic", mode: "api_key", label: "Anthropic API Key", status: "missing" },
          ],
          authOrder: ["anthropic-api-key"],
        },
      ],
    })),
  })} />);

  fireEvent.click(screen.getByRole("tab", { name: "模型" }));

  expect(await screen.findByRole("heading", { level: 3, name: "OpenAI" })).toBeDefined();
  expect(screen.getByText("ChatGPT / Codex")).toBeDefined();
  expect(screen.getByText("OpenAI API Key")).toBeDefined();
  expect(screen.getByText("openai/gpt-5.5")).toBeDefined();
  expect(screen.queryByText("Codex Gateway")).toBeNull();
});
```

- [ ] **Step 2: Run UI test to verify it fails**

Run: `bun test apps/desktop-ui/src/chat/SettingsPage.test.tsx -t "model tab groups Codex"`

Expected: fail because `onGetModelSettings` prop and API do not exist.

- [ ] **Step 3: Add UI API client**

Create `apps/desktop-ui/src/api/modelSettings.ts`:

```ts
import type { ApiClient } from "./client";

export interface ModelCatalogEntry {
  id: string;
  modelRef: string;
  name: string;
  reasoning: boolean;
  input: string[];
}

export interface AuthProfileView {
  id: string;
  provider: string;
  mode: "api_key" | "oauth" | "token" | "none";
  label: string;
  status: "configured" | "missing" | "expired" | "error" | "unsupported";
  email?: string;
  expiresAt?: number;
  message?: string;
}

export interface ModelProviderView {
  id: string;
  name: string;
  baseUrl?: string;
  api?: string;
  auth?: string;
  models: ModelCatalogEntry[];
  authProfiles: AuthProfileView[];
  authOrder: string[];
}

export interface ModelSettingsResponse {
  providers: ModelProviderView[];
}

export const modelSettingsApi = {
  get: (client: ApiClient) => client.get<ModelSettingsResponse>("/v1/model-settings"),
};
```

- [ ] **Step 4: Thread settings prop**

Modify `apps/desktop-ui/src/chat/Settings/types.ts`:

```ts
import type { ModelSettingsResponse } from "../../api/modelSettings";
```

Add to `SettingsPageProps`:

```ts
onGetModelSettings: () => Promise<ModelSettingsResponse>;
```

Modify `apps/desktop-ui/src/App.tsx` imports:

```ts
import { modelSettingsApi } from "./api/modelSettings";
```

Pass the prop into `SettingsPage`:

```tsx
onGetModelSettings={() =>
  apiClient ? modelSettingsApi.get(apiClient) : Promise.resolve({ providers: [] })
}
```

Update test `props()` helper in `SettingsPage.test.tsx` to provide a default `onGetModelSettings`.

- [ ] **Step 5: Refactor ModelSection to load backend catalog**

In `apps/desktop-ui/src/chat/Settings/ModelSection.tsx`, replace `PROVIDERS` state with:

```ts
const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
const providers = settings?.providers ?? [];

useEffect(() => {
  let cancelled = false;
  props.onGetModelSettings()
    .then((next) => {
      if (!cancelled) setSettings(next);
    })
    .catch(() => {
      if (!cancelled) setSettings({ providers: [] });
    });
  return () => { cancelled = true; };
}, [props.onGetModelSettings]);
```

Render auth profile rows instead of a single API key row:

```tsx
<div className="provider-form-stack">
  {active.authProfiles.map((profile) => (
    <FormRow
      key={profile.id}
      label={profile.label}
      hint={profile.mode === "oauth" ? "OAuth / subscription-backed connection" : "Static credential connection"}
    >
      <div className="provider-key-display">
        <span className="provider-key-masked">
          {profile.email ?? profile.status}
        </span>
        <span className={"provider-status " + (profile.status === "configured" ? "on" : profile.status === "expired" ? "warn" : "off")}>
          {profile.status === "configured" ? "已配置" : profile.status === "expired" ? "已过期" : profile.status === "unsupported" ? "未接入" : "未配置"}
        </span>
      </div>
    </FormRow>
  ))}
</div>
```

Keep the existing OpenAI API key and ChatGPT login buttons by routing button clicks based on `profile.id === "openai-api-key"` and `profile.id === "codex"`:

```tsx
{profile.id === "codex" ? (
  <button type="button" className="btn-primary btn-sm" onClick={() => void props.onSignInWithChatGPT()}>
    {profile.status === "configured" ? "重新登录" : "登录 ChatGPT"}
  </button>
) : null}
{profile.id === "openai-api-key" ? (
  <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(true)}>
    {profile.status === "configured" ? "更换" : "添加密钥"}
  </button>
) : null}
```

Preserve the existing API key edit form for `openai-api-key`; do not store non-OpenAI provider secrets in localStorage.

- [ ] **Step 6: Make providerCatalog non-authoritative**

Modify `apps/desktop-ui/src/chat/Settings/providerCatalog.ts` so comments state it is a fallback only. Remove `gateway` from `PROVIDERS` and ensure `validatedModelOptions` emits qualified `model.id` values such as `openai/gpt-5.4`.

Change OpenAI model entries:

```ts
{ id: "openai/gpt-5.4", hint: "通用旗舰" }
```

Remove the `gateway` provider block.

- [ ] **Step 7: Run settings UI test**

Run: `bun test apps/desktop-ui/src/chat/SettingsPage.test.tsx -t "model tab groups Codex"`

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop-ui/src/api/modelSettings.ts apps/desktop-ui/src/chat/Settings/types.ts apps/desktop-ui/src/App.tsx apps/desktop-ui/src/chat/Settings/ModelSection.tsx apps/desktop-ui/src/chat/Settings/providerCatalog.ts apps/desktop-ui/src/chat/SettingsPage.test.tsx
git commit -m "feat(ui): load model settings from gateway"
```

---

### Task 8: Agent Model Picker Auth Profile Override

**Files:**
- Modify: `apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx`
- Modify: `apps/desktop-ui/src/chat/AgentEditModal.test.tsx`
- Modify: `apps/desktop-ui/src/chat/Settings/providerCatalog.ts`

- [ ] **Step 1: Write picker test**

Modify `apps/desktop-ui/src/chat/AgentEditModal.test.tsx`:

```ts
test("model picker uses provider-qualified values", () => {
  renderAgentEditModal({
    authStatus: {
      active: "api_key",
      apiKey: { state: "set", source: "keychain" },
      codex: { state: "not_signed_in" },
    },
  });

  const model = screen.getByRole("combobox", { name: "模型" });
  expect(model.textContent).toContain("openai/gpt-5.4");
  expect(model.textContent).not.toContain("gateway/auto");
});
```

Use the existing render helper in `AgentEditModal.test.tsx`; if the helper has a different name, add the assertion to the nearest existing model-field test.

- [ ] **Step 2: Run picker test to verify it fails**

Run: `bun test apps/desktop-ui/src/chat/AgentEditModal.test.tsx -t "provider-qualified"`

Expected: fail while the picker still uses old model ids or test helper lacks the new expectation.

- [ ] **Step 3: Update OverviewTab model display**

Modify `apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx` option rendering:

```tsx
<option key={opt.model.id} value={opt.model.id}>
  {opt.model.id}
  {opt.model.hint ? ` — ${opt.model.hint}` : ""}
  {opt.configured ? "" : "（未配置）"}
</option>
```

Keep this structure, but ensure `opt.model.id` is already `provider/model` from Task 7.

Add helper text:

```tsx
hint={
  hasOptions
    ? "模型以 provider/model 保存；连接方式可在模型设置中调整默认优先级。"
    : "尚未配置任何模型提供方。请到「设置 → 模型」中添加连接方式。"
}
```

- [ ] **Step 4: Preserve explicit `@profile` values**

In `validatedModelOptions` in `providerCatalog.ts`, when preserving the current model, do not split or discard `@profile`. The preserved option should use the full string:

```ts
model: { id: preserveModel, hint: owner ? "当前选择" : "未识别" }
```

- [ ] **Step 5: Run picker tests**

Run: `bun test apps/desktop-ui/src/chat/AgentEditModal.test.tsx apps/desktop-ui/src/chat/editAgentTabs/tabs.test.tsx`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx apps/desktop-ui/src/chat/AgentEditModal.test.tsx apps/desktop-ui/src/chat/Settings/providerCatalog.ts
git commit -m "feat(ui): use provider-qualified agent models"
```

---

### Task 9: End-to-End Verification and Cleanup

**Files:**
- Modify exact legacy model string assertions exposed by Step 1-4 verification.
- No production files should change in this task unless a test exposes a real integration bug.

- [ ] **Step 1: Run focused gateway tests**

Run:

```bash
bun test apps/gateway/src/runtime/modelProviderResolver.test.ts apps/gateway/src/runtime/anthropicModelProvider.test.ts apps/gateway/src/runtime/resolveLlm.test.ts apps/gateway/src/routes/modelSettings.test.ts apps/gateway/src/domain/modelMigration.test.ts
```

Expected: pass.

- [ ] **Step 2: Run focused desktop UI tests**

Run:

```bash
bun test apps/desktop-ui/src/chat/SettingsPage.test.tsx apps/desktop-ui/src/chat/AgentEditModal.test.tsx apps/desktop-ui/src/chat/editAgentTabs/tabs.test.tsx
```

Expected: pass.

- [ ] **Step 3: Run typechecks**

Run:

```bash
bun --cwd apps/gateway run typecheck
bun --cwd apps/desktop-ui run typecheck
```

Expected: both commands pass.

- [ ] **Step 4: Inspect provider catalog cleanup**

Run:

```bash
rg -n "\"gateway\"|Codex Gateway|gateway/auto|gateway/long-context|gateway/cheap" apps/desktop-ui/src apps/gateway/src packages/protocol/src
```

Expected: remaining matches are migration tests, migration helpers, or historical comments. No live settings provider list should expose `Codex Gateway`.

- [ ] **Step 5: Commit test cleanup**

If Step 1-4 required changes, commit them:

```bash
git add apps/gateway/src apps/desktop-ui/src packages/protocol/src
git commit -m "test: cover model provider auth migration"
```

When no files changed, skip Step 5.

---

## Self-Review

- Spec coverage: Tasks 1-3 cover OpenClaw-compatible data/catalog/status; Tasks 4-5 cover runtime resolver, OpenAI API key, Codex OAuth, and Anthropic Messages; Tasks 6-8 cover migration and UI; Task 9 covers verification and cleanup.
- Placeholder scan: This plan contains no `TBD`, `TODO`, or unspecified test commands. Code snippets provide concrete function names and paths.
- Type consistency: The shared wire names are `modelRef`, `authProfiles`, `authOrder`, `api_key`, and `provider/model@profile`; later tasks use the same names.
