# Phase 3c — ChatGPT Subscription OAuth as LLM Provider

> Sister design to Phase 3b ([2026-04-27-l0-phase-3b-design.md](./2026-04-27-l0-phase-3b-design.md)). Phase 3b wired the gateway to `@openai/agents` with API-key auth. Phase 3c adds a second LLM provider that authenticates against the user's ChatGPT Plus/Pro subscription via OAuth + PKCE, routing requests to ChatGPT's backend API instead of `api.openai.com`. Goal: let users save costs by using their existing subscription instead of pay-per-token API.

**Status:** Approved (brainstorm → spec). Implementation plan to follow.

**Companion plan:** `docs/superpowers/plans/2026-04-27-l0-phase-3c-codex-subscription.md` (to be written next).

---

## Goal

Enable Vulture to use the user's ChatGPT subscription as an LLM provider with **zero external CLI dependency**:

1. OAuth + PKCE login from inside Vulture's UI ("Sign in with ChatGPT" button)
2. Vulture maintains its own auth store (`<profile_dir>/codex_auth.json`); does not depend on Codex CLI being installed
3. One-time import of existing `~/.codex/auth.json` credentials (for users coming from Codex CLI)
4. Gateway routes LLM calls to `https://chatgpt.com/backend-api/responses` with appropriate auth headers
5. **All Phase 3a/3b infrastructure (`makeShellCallbackTools`, `ApprovalQueue`, `RunStore`, `PolicyEngine`, audit logging) stays active** — Codex auth is a drop-in LLM provider replacement, not an architectural change

---

## Scope

| Item | In | Out |
|---|---|---|
| OAuth + PKCE flow (browser-based) via `https://auth.openai.com/oauth/authorize` | ✅ | — |
| Local axum callback server (port 1455 with auto-fallback) | ✅ | — |
| Token storage in profile dir as JSON (mode 0600) | ✅ | — |
| Background token refresh (60s before expiry) with concurrent-refresh singleton | ✅ | — |
| One-time import from `~/.codex/auth.json` if Vulture's store missing | ✅ | — |
| `chatgpt.com/backend-api/responses` request routing with `chatgpt-account-id`, `OpenAI-Beta`, `originator`, `session_id`, `conversation_id` headers | ✅ | — |
| `makeLazyLlm` extended to 3-way priority: Codex > API key > stub | ✅ | — |
| Codex token expiry → explicit failure surfaced to user (NOT silent fallback) | ✅ | — |
| UI sidebar `AuthPanel` (settings expandable) | ✅ | — |
| First-launch onboarding card when zero auth configured | ✅ | — |
| Tauri commands `start_chatgpt_login`, `sign_out_chatgpt`, `get_auth_status` | ✅ | — |
| macOS Keychain storage instead of file | — | ❌ Phase 4+ |
| Windows / Linux platforms | — | ❌ macOS-only project |
| Multi-account (one Vulture, multiple ChatGPT accounts) | — | ❌ YAGNI |
| Auto-fallback to API key when Codex expires | — | ❌ violates "explicit not silent" |
| Per-agent provider preference (some agents Codex, others API) | — | ❌ overkill for L0 |
| Real-time Codex quota / billing visibility | — | ❌ OpenAI doesn't expose public quota API |
| Streaming reasoning tokens display | — | ❌ same out-of-scope as Phase 3b |
| Codex CLI tracking (auto-update Vulture when codex CLI changes) | — | ❌ deliberately decoupled |

---

## Design decisions (from brainstorm)

| Question | Decision |
|---|---|
| Q1 — Tool execution under Codex | **D2 (full reuse of Vulture's tools)**: Codex auth is a drop-in LLM provider; all `makeShellCallbackTools` / `ApprovalQueue` / audit pipeline stays. (Originally planned A — spawn `codex exec` subprocess — superseded by Q3 finding) |
| Q2 — Codex CLI not installed | **N/A** (D2 has zero CLI dependency) |
| Q3 — Path A vs D | **D2 (self-implemented OAuth + direct API)**: industry pattern (Hermes, OpenClaw, opencode-openai-codex-auth all do this); aligns with OpenAI's documented [Codex Auth flow](https://developers.openai.com/codex/auth) |
| Q4 — Existing `~/.codex/auth.json` users | **b (one-time import)**: detect on first launch, copy creds to Vulture's store, after that Vulture's store is source of truth |
| Q5 — Auth UI placement | **b + a touch of c**: sidebar footer settings panel as primary entry; first-launch onboarding card on main area when zero auth |
| Q6 — Codex + API key both configured | **a (Codex always wins)**: serves the "save cost" goal; explicit sign-out required to fall back to API key |
| Q7 — Token plumbing shell→gateway | **a + failure cascade**: gateway calls `GET /auth/codex` on shell HTTP per run; on 401 calls `POST /auth/codex/refresh` and retries; second 401 → fallback to stub fallback (reflects Codex expired) |

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│ UI (apps/desktop-ui)                                                │
│                                                                     │
│  ConversationList (Phase 3b)        ChatView (Phase 3b)             │
│  + AuthPanel (NEW, sidebar footer)  + onboarding card (NEW, when    │
│   - Codex sign in / out / status      authStatus.active === "none") │
│   - API key save / clear                                            │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ Tauri invoke / HTTP
┌─────────────────────────────▼───────────────────────────────────────┐
│ Tauri shell (apps/desktop-shell)                                    │
│                                                                     │
│  NEW: codex_auth.rs                                                 │
│   • PKCE generation                                                 │
│   • axum local callback server (127.0.0.1:1455 with fallback)       │
│   • exchange code → tokens                                          │
│   • decode id_token → chatgpt-account-id, email                     │
│   • storage: <profile>/codex_auth.json (mode 0600)                  │
│   • background refresh (tokio interval, 60s before expiry)          │
│   • singleton concurrent refresh guard                              │
│   • one-time import from ~/.codex/auth.json                         │
│                                                                     │
│  EXTEND: tool_callback.rs (existing shell HTTP server)              │
│   • NEW: GET /auth/codex                                            │
│      → 200 {access_token, account_id, expires_at}                   │
│      → 401 {code: "auth.codex_expired"}                             │
│      → 404 {code: "auth.codex_not_signed_in"}                       │
│   • NEW: POST /auth/codex/refresh                                   │
│      → 200 with new access_token (calls singleton refresh)          │
│      → 401 if refresh failed (mark store invalid)                   │
│                                                                     │
│  EXTEND: commands.rs                                                │
│   • NEW: start_chatgpt_login() -> ChatGPTLoginStart {url}           │
│   • NEW: sign_out_chatgpt() -> ()                                   │
│   • RENAME/EVOLVE: get_openai_auth_status() →                       │
│       get_auth_status() -> AuthStatusView                           │
│   • DELETE: start_codex_login (the old `codex login` CLI spawn)     │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ HTTP /auth/codex (per run)
┌─────────────────────────────▼───────────────────────────────────────┐
│ Gateway (apps/gateway)                                              │
│                                                                     │
│  NEW: runtime/codexLlm.ts                                           │
│   • makeCodexLlm(opts): LlmCallable                                 │
│   • Per run: fetch GET shell /auth/codex → token                    │
│   • Configure @openai/agents (or fetch wrapper):                    │
│       baseURL = https://chatgpt.com/backend-api                     │
│       headers (per request):                                        │
│         Authorization: Bearer <access_token>                        │
│         OpenAI-Beta: responses=experimental                         │
│         chatgpt-account-id: <account_id from id_token>              │
│         originator: vulture                                         │
│         session_id: <derived per conversation>                      │
│         conversation_id: <conversation.id>                          │
│   • On 401 from chatgpt.com/backend-api: POST shell                 │
│     /auth/codex/refresh, retry once. Second 401 → throw             │
│     ToolCallError("auth.codex_expired", ...)                        │
│                                                                     │
│  EXTEND: runtime/resolveLlm.ts (existing FU-3 lazy resolver)        │
│   • Priority: codex.ready (per shell /auth/status)                  │
│              > OPENAI_API_KEY env                                   │
│              > stub fallback                                        │
│   • Codex shell-side 401 → fallback to stub (with explicit          │
│     "Codex 已过期" final message, NOT silent API-key downgrade)     │
│                                                                     │
│  KEEP UNCHANGED:                                                    │
│   • makeShellCallbackTools (Phase 3b) — same wrapper, same          │
│     ApprovalQueue, same Rust /tools/invoke                          │
│   • ApprovalQueue, RunStore, PolicyEngine — bypass-free path        │
│   • All audit logging                                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## OAuth + token lifecycle

### Login flow (first-time or re-login)

```text
1. User clicks "Sign in with ChatGPT" (sidebar AuthPanel or onboarding card)
   → invoke<ChatGPTLoginStart>("start_chatgpt_login")

2. Tauri shell (Rust):
   a. Generate PKCE
      code_verifier  = base64url(random_32_bytes)
      code_challenge = base64url(sha256(code_verifier))
      state          = base64url(random_16_bytes)
   b. Bind axum local server on 127.0.0.1:1455
      (auto-fallback via pick_free_port if 1455 busy; redirect_uri updated)
      route GET /auth/callback holds a oneshot::Sender<AuthCode>
   c. Compose authorize URL:
      https://auth.openai.com/oauth/authorize
        ?client_id=app_EMoamEEZ73f0CkXaXp7hrann
        &response_type=code
        &redirect_uri=http://localhost:1455/auth/callback
        &scope=openid+profile+email+offline_access
        &code_challenge=<challenge>
        &code_challenge_method=S256
        &state=<state>
   d. open::open(url) → user's default browser
   e. Return ChatGPTLoginStart { url } to UI
      (UI shows "Waiting for browser..." with cancel button)

3. User completes browser login → ChatGPT 302s to
   http://localhost:1455/auth/callback?code=<code>&state=<state>

4. Tauri shell callback handler:
   a. Verify state (CSRF protection)
   b. POST https://auth.openai.com/oauth/token
        Content-Type: application/x-www-form-urlencoded
        Body: grant_type=authorization_code
              &client_id=app_EMoamEEZ73f0CkXaXp7hrann
              &code=<code>
              &code_verifier=<verifier>
              &redirect_uri=http://localhost:1455/auth/callback
   c. Response: { access_token, refresh_token, id_token, expires_in }
   d. Decode id_token JWT (no signature verification needed — local
      session, not federated trust). Extract `chatgpt-account-id` and
      `email` from the "https://api.openai.com/auth" claim.
   e. Write <profile_dir>/codex_auth.json (atomic write, mode 0600):
      {
        "access_token": "<...>",
        "refresh_token": "<...>",
        "id_token": "<...>",
        "account_id": "<uuid>",
        "email": "user@example.com",
        "expires_at": 1714238400000,
        "stored_at": 1714234800000,
        "imported_from": null
      }

5. UI re-fetches via get_auth_status() → AuthPanel updates to "Codex 已登录 · email"
```

### Background refresh

```rust
// Tauri shell on startup:
tokio::spawn(async {
    loop {
        if let Some(creds) = read_codex_store().await? {
            if creds.expires_at - unix_now() < 60_000 {  // 60s margin
                match refresh_token_singleton().await {
                    Ok(new) => write_codex_store(new).await?,
                    Err(RefreshError::InvalidGrant) => mark_store_invalid().await?,
                    Err(_) => { /* network blip, retry next tick */ }
                }
            }
        }
        sleep(30_000).await;  // check every 30s
    }
});
```

### Refresh API call

```text
POST https://auth.openai.com/oauth/token
  Content-Type: application/x-www-form-urlencoded
  Body: grant_type=refresh_token
        &client_id=app_EMoamEEZ73f0CkXaXp7hrann
        &refresh_token=<old refresh_token>
Response: { access_token, refresh_token, id_token, expires_in }
```

If `refresh_token` rotates (response includes a new one), persist it.

### Concurrent refresh singleton

Multiple in-flight gateway requests can race to refresh. The shell uses a `Arc<Mutex<Option<Shared<RefreshFuture>>>>`:

```rust
async fn refresh_token_singleton(state: &CodexState) -> Result<Creds> {
    let mut guard = state.refresh_inflight.lock().await;
    if let Some(shared) = &*guard {
        let fut = shared.clone();
        drop(guard);
        return fut.await;
    }
    let fut = futures::future::FutureExt::shared(
        Box::pin(do_refresh()) as BoxFuture<_>
    );
    *guard = Some(fut.clone());
    drop(guard);
    let result = fut.await;
    *state.refresh_inflight.lock().await = None;
    result
}
```

Only one POST to `auth.openai.com/oauth/token` flies even with 10 concurrent gateway calls.

### One-time import

```rust
fn ensure_codex_store(profile_dir: &Path) -> Result<()> {
    let our_path = profile_dir.join("codex_auth.json");
    if our_path.exists() { return Ok(()); }

    let codex_path = home_dir()?.join(".codex").join("auth.json");
    if !codex_path.exists() { return Ok(()); }

    let codex_creds = parse_codex_auth(&codex_path)?;
    let our_creds = CodexCreds {
        imported_from: Some("~/.codex/auth.json".into()),
        imported_at: Some(unix_now()),
        ..codex_creds
    };
    write_atomic(&our_path, &our_creds)?;
    Ok(())
}
```

UI shows "凭证已从 Codex CLI 导入（一次性）" when `imported_from` is non-null. After this point, Codex CLI's `~/.codex/auth.json` and Vulture's store are independent — refreshing Vulture's store does not write back to Codex CLI's location.

---

## UI

### `apps/desktop-ui/src/chat/AuthPanel.tsx` (NEW)

Sidebar footer (replaces current empty footer area in `ConversationList`):

```text
┌─────────────────────────────────────┐
│ ▼ 设置                              │  ← header, toggle expand
├─────────────────────────────────────┤
│ ChatGPT 订阅 (推荐)                 │
│  ⦿ 已登录 · johnny@example.com     │
│  过期：2 小时后                     │
│  凭证已从 Codex CLI 导入            │  ← only if imported_from set
│  [Sign out]                         │
│                                     │
│ ─────────────                        │
│                                     │
│ OpenAI API key (备选)               │
│  ◯ 未设置                          │
│  [_______________________] [Save]   │
└─────────────────────────────────────┘
```

States rendered for `codex.state`:
- `not_signed_in` → big `[Sign in with ChatGPT]` button
- `logging_in` → "等待浏览器完成登录…" + spinner + cancel
- `signed_in` → email + expiry + sign-out button
- `expired` → red "凭证已过期" + `[Sign in again]`

Props (from `App.tsx`):
```tsx
interface AuthPanelProps {
  authStatus: AuthStatusView;
  onSignInWithChatGPT: () => Promise<void>;
  onSignOutCodex: () => Promise<void>;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
}

interface AuthStatusView {
  active: "codex" | "api_key" | "none";
  codex: {
    state: "not_signed_in" | "signed_in" | "expired" | "logging_in";
    email?: string;
    expiresAt?: number;
    importedFrom?: string;
  };
  apiKey: {
    state: "not_set" | "set";
    source?: "keychain" | "env";
  };
}
```

### Onboarding card (in `ChatView`)

When `messages.length === 0 && runEvents.length === 0 && authStatus.active === "none"`, replace the existing empty-state hint with:

```text
                      V
                  Vulture
       选择登录方式开始使用：

  ┌─────────────────────────────────┐
  │ ⚡ Sign in with ChatGPT          │
  │ 用订阅省 API key 费用（推荐）    │
  └─────────────────────────────────┘

  ┌─────────────────────────────────┐
  │ 🔑 OpenAI API key                │
  │ 按 token 计费                    │
  └─────────────────────────────────┘
```

Both buttons trigger the corresponding action through the same `App.tsx` callbacks the AuthPanel uses. Once `authStatus.active !== "none"`, this card is replaced by the standard empty state ("选择智能体，然后直接输入任务").

### Auth pill (runtime-debug strip, top of ChatView)

Existing strip already shows `auth:<label>`. Extend to 4 states:

```
auth:Codex(johnny@)        ← signed_in (truncate email at @, max 5 chars before)
auth:API key
auth:Codex 已过期⚠
auth:未认证
```

Pill is clickable: clicking expands the AuthPanel in sidebar (secondary entry).

### Tauri commands

NEW:
```ts
invoke<ChatGPTLoginStart>("start_chatgpt_login")
  → { url: string, alreadyAuthenticated: boolean }
  // Synchronously opens browser; resolves once user completes flow OR after 60s timeout.

invoke<void>("sign_out_chatgpt")
  // Deletes <profile>/codex_auth.json. Notifies via event for UI refresh.

invoke<AuthStatusView>("get_auth_status")
  // Replaces get_openai_auth_status; returns unified shape.
```

DELETE:
- `start_codex_login` (old `codex login` CLI subprocess flow)

KEEP:
- `set_openai_api_key`, `clear_openai_api_key`

---

## Failure modes

| Scenario | Trigger location | Handling | UI |
|---|---|---|---|
| Browser closed without completing login | shell start_chatgpt_login | 60s timeout closes callback channel | "登录已取消" |
| Port 1455 occupied | shell startup | pick_free_port(1455, 50); redirect_uri updated | transparent |
| State mismatch (CSRF) | shell callback handler | reject; 400 to browser | "登录失败：state 验证不通过" |
| Token endpoint network drop | shell exchange | retry 3× exponential backoff (500ms/1s/2s); fail → throw | "无法连接 OpenAI 认证服务，请检查网络" |
| Refresh fails: refresh_token expired (90 days) | shell background | mark store invalid; preserve store contents for diagnostics | red auth pill "Codex 已过期" + AuthPanel `[Sign in again]` |
| Refresh fails: network drop | shell background | do not mark invalid; retry next 30s tick | unchanged; user's next message may still succeed if access_token valid |
| Token expired but refresh hasn't fired (gateway races first) | gateway → ChatGPT API 401 | gateway POST shell /auth/codex/refresh, retry once | user-invisible (~200ms latency) |
| Forced refresh also fails | gateway → ChatGPT API second 401 | throw `ToolCallError("auth.codex_expired", ...)` → run.failed | ChatView shows "Codex 已过期，请重新登录"; run failed |
| User revokes auth at chatgpt.com | refresh returns invalid_grant | same as expired | same |
| Profile dir write permission lost | shell write_codex_store | throw + log; user manual chmod | "无法保存登录状态" |
| codex_auth.json corrupt | shell read_codex_store | delete + treat as not signed in + warn log | silent; UI shows 未认证 |
| Multiple Vulture instances | shell startup | single_instance lock (Phase 1) rejects | existing behavior |
| chatgpt.com/backend-api rate limited (429) | gateway → ChatGPT API | no retry (per-user quota); surface as run.failed | "今日 ChatGPT 配额已用尽" |
| Model not supported by Codex | gateway → ChatGPT API 400 model_not_supported | no retry; surface error | "该模型不支持 ChatGPT 订阅，请切换 API key 或换模型" |

### Key invariants

1. **Tokens never leave the gateway boundary**: gateway only injects to LLM request `Authorization` header; never logs, audits, or returns to UI (UI reads auth status via Tauri commands, never raw token).
2. **Refresh only runs in shell**: gateway never directly calls `auth.openai.com/oauth/token`. Only refresh trigger is shell (background interval + `/auth/codex/refresh` on demand).
3. **Codex invalid ≠ silent error**: a transient network blip during refresh does not mark the store invalid; only `invalid_grant`/`unauthorized` from OpenAI does.
4. **Failure surfaces explicitly to user**: when Codex fails, the user sees a clear error ("Codex 已过期，请重新登录"), NEVER silent fallback to API key — to prevent unexpected API billing.

---

## Testing strategy

| Layer | Tests |
|---|---|
| Rust shell `codex_auth` | PKCE generation correctness; state matching; token endpoint mocked; refresh singleton (concurrent calls → one POST); profile file permission 0600; one-time import logic |
| Rust shell `tool_callback` | `/auth/codex` returns valid/invalid/not-signed-in; `/auth/codex/refresh` triggers refresh; 401 path |
| Gateway `codexLlm` | 401 on chatgpt.com → calls shell refresh → retries; second 401 → ToolCallError; correct headers (Authorization, chatgpt-account-id, OpenAI-Beta, originator); correct baseURL |
| Gateway `resolveLlm` (extended) | Three-way priority: codex.ready → codex; no codex + env key → openai; neither → stub; codex shell-side 401 → stub fallback |
| UI `AuthPanel` | All 4 codex states render; button interactions; AuthStatusView prop changes update DOM |
| Manual smoke | Full OAuth flow (real ChatGPT account); first send → streaming reply via Codex; sign out → `[Sign in again]` reappears; one-time import (place fixture `~/.codex/auth.json` first launch) |

---

## Migration / rollout

- **Phase 3c is additive**: shipping it never breaks existing API-key users (their flow is the second priority in `resolveLlm`)
- **Existing Codex CLI users**: on first launch after Phase 3c lands, see "Codex 已登录" auto-imported (no manual intervention)
- **No DB migration**: profile dir gets one new file (`codex_auth.json`); no SQLite changes
- **Out-of-scope items don't block**: Keychain storage, Windows/Linux, multi-account — all explicitly Phase 4+

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@openai/agents` SDK doesn't support custom baseURL + headers | Medium | Implementation cost ~2× (need fetch wrapper to intercept) | M1 first task spikes this; fallback is ~50-line fetch middleware that rewrites SDK requests' baseURL + headers |
| OpenAI changes `chatgpt.com/backend-api` protocol | Medium | Need rapid `codexLlm.ts` patch | Track codex CLI commits + opencode-openai-codex-auth + Hermes; `codexLlm.ts` is single-file, easy to hot-fix |
| OpenAI revokes `client_id app_EMoamEEZ73f0CkXaXp7hrann` | Low | All Codex logins fail | Shared with codex CLI / Hermes / OpenClaw / opencode plugin — a unilateral revocation impacts the whole ecosystem |
| PKCE/OAuth implementation bug | Medium | Login fails | Use spec-compliant Rust crates (`pkce`, `sha2`, `base64url`); thorough unit tests; M1 includes OAuth e2e tests |
| Refresh token rotation mishandled | Medium | One refresh succeeds, next fails | Always overwrite stored refresh_token if response includes a new one; unit test |
| Profile dir codex_auth.json on iCloud / Dropbox sync | Low | Tokens sync to cloud | Profile dir is `~/Library/Application Support/`; macOS does not sync this by default |
| codex_auth.json races between shell refresh + gateway read | Low | Stale token returned | shell uses atomic file write (write to .tmp + rename); gateway never caches token across runs |

---

## Acceptance criteria

- A user with no auth configured opens Vulture → sees onboarding card → clicks "Sign in with ChatGPT" → completes browser flow → sidebar AuthPanel shows "Codex 已登录 · email" → sends a message → assistant streams a reply (via chatgpt.com/backend-api with their subscription billing).
- A user with an existing `~/.codex/auth.json` (from prior Codex CLI use) opens Vulture for the first time → AuthPanel automatically shows "Codex 已登录 · email" with "凭证已从 Codex CLI 导入" hint; can send messages immediately.
- A user signed into Codex disconnects from ChatGPT (via chatgpt.com) → next send produces "Codex 已过期，请重新登录" + run.failed; AuthPanel shows red "已过期" with `[Sign in again]`.
- A user with both Codex AND `OPENAI_API_KEY` set: messages route via Codex (subscription), not API. Signing out of Codex switches to API key without restart.
- A user with neither auth configured: messages get the existing "OPENAI_API_KEY not configured..." stub fallback message.
- Cancelling a Codex run mid-stream: SSE closes; run marked `cancelled`; pending approvals released — same as Phase 3b.
- All Phase 3a/3b acceptance criteria continue to pass: tool calls audited, approval flow via inline ApprovalCard, SSE reconnect with Last-Event-ID, gateway-restart sweep marks in-flight runs failed.

---

## Open questions

None at design time. Implementation plan will spell out:
- The exact `@openai/agents` configuration (or fetch wrapper) shape, contingent on M1 SDK spike
- Exact JWT claim path for `chatgpt-account-id` and `email` extraction from `id_token`
- Token refresh interval clock-skew tolerance

These are technical implementation details, not architectural choices.
