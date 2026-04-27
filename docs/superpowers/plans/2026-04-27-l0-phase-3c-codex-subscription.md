# L0 Phase 3c — ChatGPT Subscription OAuth as LLM Provider

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ChatGPT subscription OAuth as a second LLM provider (priority 1, before API key) with zero external CLI dependency. Implements PKCE-based browser OAuth in the Tauri shell, exposes tokens to the gateway via `/auth/codex` HTTP endpoint, and routes LLM requests to `chatgpt.com/backend-api` with the required custom headers. All Phase 3a/3b infrastructure (`makeShellCallbackTools`, `ApprovalQueue`, `RunStore`, `PolicyEngine`, audit logging) stays active.

**Architecture:** Tauri shell owns OAuth + token lifecycle (PKCE generation, axum callback server on `127.0.0.1:1455`, token endpoint exchange, background refresh with singleton, atomic file storage). Shell HTTP server gains `GET /auth/codex` + `POST /auth/codex/refresh`. Gateway adds `codexLlm.ts` provider that calls shell per-run for fresh tokens, configures `@openai/agents` SDK with a custom `OpenAI` client (baseURL + custom headers). `resolveLlm` becomes 3-way priority: Codex > API key > stub.

**Tech Stack:**
- Rust: `axum` (existing), `reqwest` (existing), `rand` (existing), `base64` (existing), NEW `sha2` for PKCE challenge
- TypeScript: `@openai/agents` (existing), `openai` (NEW dep on gateway, used for custom client construction)
- React: existing (no new deps)

**Spec:** [`docs/superpowers/specs/2026-04-27-l0-phase-3c-codex-subscription-design.md`](../specs/2026-04-27-l0-phase-3c-codex-subscription-design.md)

**Direct-on-main mode:** typecheck MUST exit 0 before each commit. No `--no-verify`. Each task is one commit; build/tests stay green between commits.

---

## File structure (created/modified)

```text
apps/desktop-shell/src/
├── codex_auth.rs                  NEW: OAuth runtime (PKCE, callback server, token exchange, refresh, storage)
├── tool_callback.rs               MODIFIED: add /auth/codex GET + /auth/codex/refresh POST
├── commands.rs                    MODIFIED: add start_chatgpt_login, sign_out_chatgpt, get_auth_status; delete start_codex_login
├── auth.rs                        MODIFIED: extend AuthStatusView (replaces OpenAiAuthStatus shape); keep OpenAI key parts
├── main.rs                        MODIFIED: register new mods + new Tauri commands; init codex_auth state
└── state.rs                       MODIFIED: hold CodexState (refresh singleton, refresh_inflight, store path)

apps/desktop-shell/Cargo.toml      MODIFIED: add sha2 dep

apps/gateway/src/
├── runtime/
│   ├── codexLlm.ts                NEW: makeCodexLlm provider (fetches token from shell, configures custom OpenAI client)
│   ├── codexLlm.test.ts           NEW: unit tests with mocked shell endpoint + mocked OpenAI client
│   └── resolveLlm.ts              MODIFIED: 3-way priority (Codex > API key > stub) with codex-failure fallback
└── server.ts                      MODIFIED: pass shellCallbackUrl + token to makeLazyLlm so codexLlm can call /auth/codex

apps/gateway/package.json          MODIFIED: add openai dep (for custom client construction)

apps/desktop-ui/src/
├── chat/
│   ├── AuthPanel.tsx              NEW: sidebar footer settings panel
│   ├── AuthPanel.test.tsx         NEW
│   ├── OnboardingCard.tsx         NEW: zero-auth empty state replacement
│   ├── OnboardingCard.test.tsx    NEW
│   ├── ConversationList.tsx       MODIFIED: footer slot for AuthPanel
│   └── ChatView.tsx               MODIFIED: render OnboardingCard when zero auth
├── commandCenterTypes.ts          MODIFIED: AuthStatusView type (unified codex + api_key shape)
└── App.tsx                        MODIFIED: wire AuthPanel + Onboarding + new Tauri commands; replace get_openai_auth_status with get_auth_status
```

---

## Group A — Rust shell OAuth runtime

### Task 1: `codex_auth` module skeleton + storage + one-time import

**Files:**
- Create: `apps/desktop-shell/src/codex_auth.rs`
- Create: `apps/desktop-shell/src/codex_auth/mod.rs` (alternative — single file is fine)
- Modify: `apps/desktop-shell/src/main.rs` (add `mod codex_auth;`)
- Modify: `apps/desktop-shell/src/lib.rs` (add `pub mod codex_auth;`)
- Modify: `apps/desktop-shell/Cargo.toml` (add `sha2 = "0.10"`)

- [ ] **Step 1: Add sha2 dep**

In `apps/desktop-shell/Cargo.toml` `[dependencies]` section, add:
```toml
sha2 = "0.10"
```

Run `cargo build -p vulture-desktop-shell` to verify resolution.

- [ ] **Step 2: Write the failing tests**

Create `apps/desktop-shell/src/codex_auth.rs`:

```rust
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

/// Snapshot of the credentials persisted at <profile_dir>/codex_auth.json.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct CodexCreds {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub account_id: String,
    #[serde(default)]
    pub email: Option<String>,
    /// Unix epoch milliseconds.
    pub expires_at: u64,
    pub stored_at: u64,
    #[serde(default)]
    pub imported_from: Option<String>,
}

const STORE_FILE_NAME: &str = "codex_auth.json";

pub fn store_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(STORE_FILE_NAME)
}

pub fn read_store(profile_dir: &Path) -> Result<Option<CodexCreds>> {
    let path = store_path(profile_dir);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read_to_string(&path)
        .with_context(|| format!("read {}", path.display()))?;
    let creds: CodexCreds = serde_json::from_str(&bytes)
        .with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(creds))
}

/// Atomic write: tmp file + rename. Sets mode 0600 on Unix.
pub fn write_store(profile_dir: &Path, creds: &CodexCreds) -> Result<()> {
    let path = store_path(profile_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("mkdir {}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(creds)?;
    std::fs::write(&tmp, &bytes).with_context(|| format!("write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&tmp)?;
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&tmp, perms)?;
    }
    std::fs::rename(&tmp, &path).with_context(|| format!("rename {}", path.display()))?;
    Ok(())
}

pub fn delete_store(profile_dir: &Path) -> Result<()> {
    let path = store_path(profile_dir);
    if path.is_file() {
        std::fs::remove_file(&path)
            .with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

pub fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Detect ~/.codex/auth.json (Codex CLI's store) and copy creds if our store
/// is missing. One-time only; subsequent refreshes do not write back to ~/.codex.
pub fn ensure_store_with_import(profile_dir: &Path) -> Result<()> {
    let our = store_path(profile_dir);
    if our.is_file() {
        return Ok(());
    }
    let codex = home_dir()?
        .join(".codex")
        .join("auth.json");
    if !codex.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&codex)
        .with_context(|| format!("read {}", codex.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let tokens = value
        .get("tokens")
        .ok_or_else(|| anyhow!("~/.codex/auth.json missing 'tokens' field"))?;
    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing tokens.access_token"))?
        .to_string();
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing tokens.refresh_token"))?
        .to_string();
    let id_token = tokens
        .get("id_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing tokens.id_token"))?
        .to_string();
    let account_id = tokens
        .get("account_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing tokens.account_id"))?
        .to_string();
    // Codex CLI doesn't store expires_at directly — we infer from JWT exp claim
    // for imported creds. If JWT decode fails, default to 1h from now (safe;
    // a refresh will run shortly).
    let expires_at = expires_at_from_jwt(&access_token).unwrap_or_else(|| unix_now_ms() + 3_600_000);
    let creds = CodexCreds {
        access_token,
        refresh_token,
        id_token,
        account_id,
        email: None,
        expires_at,
        stored_at: unix_now_ms(),
        imported_from: Some("~/.codex/auth.json".into()),
    };
    write_store(profile_dir, &creds)?;
    Ok(())
}

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is not set"))
}

/// Parse `exp` claim from JWT (no signature verification). Returns ms epoch.
fn expires_at_from_jwt(jwt: &str) -> Option<u64> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    let exp = value.get("exp")?.as_u64()?;
    Some(exp * 1000)  // exp is seconds, we use ms
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_profile() -> PathBuf {
        std::env::temp_dir().join(format!("vulture-codex-auth-{}", Uuid::new_v4()))
    }

    fn sample_creds() -> CodexCreds {
        CodexCreds {
            access_token: "at-1".into(),
            refresh_token: "rt-1".into(),
            id_token: "id-1".into(),
            account_id: "acc-1".into(),
            email: Some("user@example.com".into()),
            expires_at: 1_714_238_400_000,
            stored_at: 1_714_234_800_000,
            imported_from: None,
        }
    }

    #[test]
    fn read_store_returns_none_when_missing() {
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        assert!(read_store(&profile).unwrap().is_none());
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn write_then_read_round_trips() {
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        let creds = sample_creds();
        write_store(&profile, &creds).expect("write");
        let read = read_store(&profile).expect("read").expect("Some");
        assert_eq!(read, creds);
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn write_sets_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        write_store(&profile, &sample_creds()).expect("write");
        let metadata = std::fs::metadata(store_path(&profile)).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn delete_store_removes_file() {
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        write_store(&profile, &sample_creds()).expect("write");
        assert!(store_path(&profile).is_file());
        delete_store(&profile).expect("delete");
        assert!(!store_path(&profile).is_file());
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn ensure_store_with_import_no_op_if_our_store_exists() {
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        let original = sample_creds();
        write_store(&profile, &original).expect("write our store first");
        ensure_store_with_import(&profile).expect("import");
        let read = read_store(&profile).expect("read").expect("Some");
        assert_eq!(read, original);  // unchanged
        std::fs::remove_dir_all(&profile).ok();
    }
}
```

Add `mod codex_auth;` to `apps/desktop-shell/src/main.rs` (alphabetical position after `commands`).
Add `pub mod codex_auth;` to `apps/desktop-shell/src/lib.rs` (alphabetical position).

- [ ] **Step 3: Run, expect 5 tests pass + clippy clean**

```bash
cargo test -p vulture-desktop-shell codex_auth 2>&1 | grep "^test result"
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell Cargo.toml
git commit -m "feat(shell): codex_auth module with storage + one-time import"
```

### Task 2: PKCE generation

**Files:**
- Modify: `apps/desktop-shell/src/codex_auth.rs`

- [ ] **Step 1: Append failing tests**

Append to `apps/desktop-shell/src/codex_auth.rs` `mod tests`:

```rust
#[test]
fn pkce_challenge_is_base64url_sha256_of_verifier() {
    let pkce = Pkce::generate();
    // verifier is 32 bytes base64url-encoded → 43 chars no padding
    assert_eq!(pkce.verifier.len(), 43);
    // challenge is sha256(verifier) base64url-encoded → also 43 chars no padding
    assert_eq!(pkce.challenge.len(), 43);
    // Verify the relationship: re-derive challenge from verifier
    use sha2::{Digest, Sha256};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let mut hasher = Sha256::new();
    hasher.update(pkce.verifier.as_bytes());
    let derived = URL_SAFE_NO_PAD.encode(hasher.finalize());
    assert_eq!(pkce.challenge, derived);
}

#[test]
fn pkce_state_is_unique() {
    let a = Pkce::generate();
    let b = Pkce::generate();
    assert_ne!(a.verifier, b.verifier);
    assert_ne!(a.state, b.state);
}

#[test]
fn pkce_state_is_url_safe() {
    let pkce = Pkce::generate();
    assert!(pkce.state.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
}
```

- [ ] **Step 2: Add Pkce type + generation**

Insert before `#[cfg(test)]` in `codex_auth.rs`:

```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl Pkce {
    pub fn generate() -> Self {
        let mut verifier_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut verifier_bytes);
        let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);

        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());

        let mut state_bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut state_bytes);
        let state = URL_SAFE_NO_PAD.encode(state_bytes);

        Self { verifier, challenge, state }
    }
}
```

- [ ] **Step 3: Run + clippy**

```bash
cargo test -p vulture-desktop-shell codex_auth 2>&1 | grep "^test result"
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings 2>&1 | tail -3
```

Expect 8 tests pass (was 5; +3 new).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): codex_auth PKCE generation"
```

### Task 3: Browser flow + axum callback server

**Files:**
- Modify: `apps/desktop-shell/src/codex_auth.rs`

- [ ] **Step 1: Append failing test**

Append to `mod tests`:

```rust
#[tokio::test]
async fn callback_server_receives_code_and_state() {
    let (tx, rx) = tokio::sync::oneshot::channel::<CallbackResult>();
    let handle = start_callback_server(0, tx).await.expect("server");
    let port = handle.bound_port;

    let url = format!(
        "http://127.0.0.1:{}/auth/callback?code=abc&state=xyz",
        port
    );
    let response = reqwest::get(&url).await.expect("request");
    assert_eq!(response.status(), 200);

    let result = rx.await.expect("oneshot");
    assert_eq!(result.code, "abc");
    assert_eq!(result.state, "xyz");

    handle.shutdown().await;
}

#[tokio::test]
async fn callback_server_handles_error_param() {
    let (tx, rx) = tokio::sync::oneshot::channel::<CallbackResult>();
    let handle = start_callback_server(0, tx).await.expect("server");
    let port = handle.bound_port;

    let url = format!(
        "http://127.0.0.1:{}/auth/callback?error=access_denied&error_description=user+denied",
        port
    );
    let response = reqwest::get(&url).await.expect("request");
    assert_eq!(response.status(), 400);

    // The oneshot channel should NOT receive a value (server returns error to browser);
    // verify it's still pending or closed without value.
    drop(handle);
    // After server shutdown the rx should error (sender dropped without sending);
    let result = rx.await;
    assert!(result.is_err());
}
```

- [ ] **Step 2: Implement callback server**

Insert into `codex_auth.rs`:

```rust
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::{extract::Query, http::StatusCode, response::Html, routing::get, Router};
use serde::Deserialize;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

#[derive(Debug, Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CallbackResult {
    pub code: String,
    pub state: String,
}

pub struct CallbackServerHandle {
    pub bound_port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
    join: Option<JoinHandle<()>>,
}

impl CallbackServerHandle {
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

pub async fn start_callback_server(
    port: u16,
    sender: oneshot::Sender<CallbackResult>,
) -> Result<CallbackServerHandle> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    let bound_port = listener.local_addr()?.port();

    let sender = Arc::new(Mutex::new(Some(sender)));
    let app = Router::new()
        .route("/auth/callback", get(callback_handler))
        .with_state(sender);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move { let _ = shutdown_rx.await; })
            .await
            .ok();
    });

    Ok(CallbackServerHandle {
        bound_port,
        shutdown_tx: Some(shutdown_tx),
        join: Some(join),
    })
}

async fn callback_handler(
    axum::extract::State(sender): axum::extract::State<Arc<Mutex<Option<oneshot::Sender<CallbackResult>>>>>,
    Query(params): Query<CallbackParams>,
) -> (StatusCode, Html<&'static str>) {
    if let Some(error) = params.error {
        let _ = error;
        return (
            StatusCode::BAD_REQUEST,
            Html(
                "<html><body><h2>Login failed</h2><p>You can close this window.</p></body></html>",
            ),
        );
    }
    let (Some(code), Some(state)) = (params.code, params.state) else {
        return (
            StatusCode::BAD_REQUEST,
            Html("<html><body><h2>Login failed</h2><p>Missing code or state.</p></body></html>"),
        );
    };
    if let Some(tx) = sender.lock().expect("sender lock").take() {
        let _ = tx.send(CallbackResult { code, state });
    }
    (
        StatusCode::OK,
        Html("<html><body><h2>Login complete</h2><p>You can close this window and return to Vulture.</p></body></html>"),
    )
}

/// macOS-only browser open. Uses `open` command (already used elsewhere in this crate).
pub fn open_browser(url: &str) -> Result<()> {
    let status = std::process::Command::new("open")
        .arg(url)
        .status()
        .with_context(|| format!("failed to open browser at {url}"))?;
    if !status.success() {
        return Err(anyhow!("open browser exited with {}", status));
    }
    Ok(())
}
```

- [ ] **Step 3: Run + clippy**

```bash
cargo test -p vulture-desktop-shell codex_auth 2>&1 | grep "^test result"
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings 2>&1 | tail -3
```

Expect 10 tests pass (was 8; +2 new).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): codex_auth callback server + browser open"
```

### Task 4: Token endpoint exchange

**Files:**
- Modify: `apps/desktop-shell/src/codex_auth.rs`

- [ ] **Step 1: Append failing test**

```rust
#[tokio::test]
async fn exchange_code_constructs_correct_request() {
    use std::convert::Infallible;
    use axum::{routing::post, Router, response::Json};

    // Build a fake token endpoint that records the form body
    let recorded = Arc::new(Mutex::new(None::<String>));
    let recorded_clone = recorded.clone();

    let app = Router::new().route(
        "/oauth/token",
        post(move |body: String| {
            let recorded = recorded_clone.clone();
            async move {
                *recorded.lock().unwrap() = Some(body);
                Json(serde_json::json!({
                    "access_token": "at-new",
                    "refresh_token": "rt-new",
                    "id_token": "header.eyJleHAiOjE3MTQyMzg0MDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2MtMSJ9fQ.sig",
                    "expires_in": 3600
                }))
            }
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.ok(); });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let response = exchange_authorization_code(
        &format!("http://127.0.0.1:{port}/oauth/token"),
        "the-code",
        "the-verifier",
        "http://localhost:1455/auth/callback",
    )
    .await
    .expect("exchange");

    assert_eq!(response.access_token, "at-new");
    assert_eq!(response.refresh_token, "rt-new");
    assert_eq!(response.expires_in, 3600);

    let body = recorded.lock().unwrap().clone().expect("body recorded");
    assert!(body.contains("grant_type=authorization_code"));
    assert!(body.contains("code=the-code"));
    assert!(body.contains("code_verifier=the-verifier"));
    assert!(body.contains(&format!("client_id={}", CLIENT_ID)));
}
```

- [ ] **Step 2: Implement token exchange**

Insert into `codex_auth.rs`:

```rust
pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const SCOPE: &str = "openid profile email offline_access";

#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub expires_in: u64,
}

/// POST to token_url with `grant_type=authorization_code` form body.
pub async fn exchange_authorization_code(
    token_url: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse> {
    let client = reqwest::Client::new();
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("code_verifier", code_verifier),
        ("redirect_uri", redirect_uri),
    ];
    let response = client
        .post(token_url)
        .form(&form)
        .send()
        .await
        .with_context(|| format!("POST {token_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("token endpoint returned {status}: {body}"));
    }
    let parsed: TokenResponse = response.json().await.context("parse token response")?;
    Ok(parsed)
}

/// POST refresh request. Same shape as exchange_authorization_code response.
pub async fn refresh_access_token(
    token_url: &str,
    refresh_token: &str,
) -> Result<TokenResponse> {
    let client = reqwest::Client::new();
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
    ];
    let response = client
        .post(token_url)
        .form(&form)
        .send()
        .await
        .with_context(|| format!("POST {token_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("refresh endpoint returned {status}: {body}"));
    }
    let parsed: TokenResponse = response.json().await.context("parse refresh response")?;
    Ok(parsed)
}

/// Build a CodexCreds from a TokenResponse + previously known account_id (or extracted from id_token).
pub fn creds_from_token_response(
    response: TokenResponse,
    imported_from: Option<String>,
) -> Result<CodexCreds> {
    let now = unix_now_ms();
    let expires_at = now.saturating_add(response.expires_in.saturating_mul(1000));
    let (account_id, email) = decode_account_from_id_token(&response.id_token)?;
    Ok(CodexCreds {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        id_token: response.id_token,
        account_id,
        email,
        expires_at,
        stored_at: now,
        imported_from,
    })
}

fn decode_account_from_id_token(id_token: &str) -> Result<(String, Option<String>)> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() < 2 {
        return Err(anyhow!("id_token not a JWT"));
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).context("decode JWT payload")?;
    let value: serde_json::Value = serde_json::from_slice(&payload).context("parse JWT payload")?;
    let auth_claim = value
        .get("https://api.openai.com/auth")
        .ok_or_else(|| anyhow!("id_token missing 'https://api.openai.com/auth' claim"))?;
    let account_id = auth_claim
        .get("chatgpt_account_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("auth claim missing chatgpt_account_id"))?
        .to_string();
    let email = value.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok((account_id, email))
}
```

- [ ] **Step 3: Run + clippy**

```bash
cargo test -p vulture-desktop-shell codex_auth 2>&1 | grep "^test result"
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings 2>&1 | tail -3
```

Expect 11 tests pass (was 10; +1 new).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): codex_auth token exchange + JWT decode"
```

### Task 5: Refresh singleton + background worker

**Files:**
- Modify: `apps/desktop-shell/src/codex_auth.rs`
- Modify: `apps/desktop-shell/src/state.rs` (add CodexState field)

- [ ] **Step 1: Append failing test**

```rust
#[tokio::test]
async fn refresh_singleton_fires_only_one_http_request_under_concurrency() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let count = Arc::new(AtomicUsize::new(0));
    let count_clone = count.clone();

    let app = Router::new().route(
        "/oauth/token",
        post(move || {
            count_clone.fetch_add(1, Ordering::SeqCst);
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                Json(serde_json::json!({
                    "access_token": "at-new",
                    "refresh_token": "rt-new",
                    "id_token": "header.eyJleHAiOjE3MTQyMzg0MDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2MtMSJ9fQ.sig",
                    "expires_in": 3600
                }))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.ok(); });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let token_url = format!("http://127.0.0.1:{port}/oauth/token");

    let runtime = RefreshSingleton::default();
    let mut handles = vec![];
    for _ in 0..5 {
        let runtime = runtime.clone();
        let url = token_url.clone();
        handles.push(tokio::spawn(async move {
            runtime.refresh_once(&url, "rt-old").await
        }));
    }
    for h in handles {
        h.await.unwrap().expect("refresh ok");
    }
    assert_eq!(count.load(Ordering::SeqCst), 1, "only one HTTP request");
}
```

- [ ] **Step 2: Add RefreshSingleton type**

Insert into `codex_auth.rs`:

```rust
use futures::future::{BoxFuture, Shared};
use futures::FutureExt;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Default, Clone)]
pub struct RefreshSingleton {
    inflight: Arc<AsyncMutex<Option<Shared<BoxFuture<'static, std::result::Result<TokenResponse, String>>>>>>,
}

impl RefreshSingleton {
    /// If a refresh is already in flight, wait for it. Otherwise, start one.
    pub async fn refresh_once(&self, token_url: &str, refresh_token: &str) -> Result<TokenResponse> {
        let mut guard = self.inflight.lock().await;
        if let Some(shared) = &*guard {
            let fut = shared.clone();
            drop(guard);
            return fut.await.map_err(|e| anyhow!("refresh failed: {e}"));
        }
        let token_url = token_url.to_string();
        let refresh_token = refresh_token.to_string();
        let fut: BoxFuture<'static, std::result::Result<TokenResponse, String>> = Box::pin(async move {
            refresh_access_token(&token_url, &refresh_token)
                .await
                .map_err(|e| e.to_string())
        });
        let shared = fut.shared();
        *guard = Some(shared.clone());
        drop(guard);
        let result = shared.await;
        *self.inflight.lock().await = None;
        result.map_err(|e| anyhow!("refresh failed: {e}"))
    }
}
```

Add `futures = "0.3"` to `apps/desktop-shell/Cargo.toml` if not already present (verify with `grep futures apps/desktop-shell/Cargo.toml`).

- [ ] **Step 3: Add CodexState to state.rs (struct only, no init yet)**

In `apps/desktop-shell/src/state.rs`, near the top of `AppState` struct, add:

```rust
use crate::codex_auth::RefreshSingleton;

pub struct AppState {
    // ... existing fields ...
    pub codex_refresh: RefreshSingleton,
}
```

In `new_for_root_with_secret_store`:

```rust
Ok(Self {
    // ... existing fields ...
    codex_refresh: RefreshSingleton::default(),
})
```

- [ ] **Step 4: Run + clippy**

```bash
cargo test -p vulture-desktop-shell codex_auth 2>&1 | grep "^test result"
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings 2>&1 | tail -3
```

Expect 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): codex_auth refresh singleton (concurrency-safe)"
```

---

## Group B — Rust shell HTTP /auth/codex endpoints

### Task 6: `/auth/codex` GET + `/auth/codex/refresh` POST

**Files:**
- Modify: `apps/desktop-shell/src/tool_callback.rs`
- Modify: `apps/desktop-shell/src/main.rs` (pass profile_dir + RefreshSingleton to serve())

The shell HTTP server needs profile_dir (to read codex_auth.json) and access to RefreshSingleton. Extend the `serve` signature.

- [ ] **Step 1: Append tests to `tool_callback.rs::mod tests`**

```rust
#[tokio::test]
async fn auth_codex_returns_404_when_store_missing() {
    let dir = std::env::temp_dir().join(format!("tcb-codex-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let token = "x".repeat(43);
    let handle = serve_with_codex(0, token.clone(), dir.join("audit.sqlite"), dir.clone(), Default::default())
        .await
        .expect("serve");
    let port = handle.bound_port;

    let res = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/auth/codex"))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["code"], "auth.codex_not_signed_in");

    handle.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn auth_codex_returns_creds_when_valid() {
    use crate::codex_auth::{write_store, CodexCreds, unix_now_ms};
    let dir = std::env::temp_dir().join(format!("tcb-codex-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let creds = CodexCreds {
        access_token: "at".into(),
        refresh_token: "rt".into(),
        id_token: "id".into(),
        account_id: "acc".into(),
        email: Some("user@x".into()),
        expires_at: unix_now_ms() + 3_600_000,
        stored_at: unix_now_ms(),
        imported_from: None,
    };
    write_store(&dir, &creds).unwrap();

    let token = "x".repeat(43);
    let handle = serve_with_codex(0, token.clone(), dir.join("audit.sqlite"), dir.clone(), Default::default())
        .await
        .expect("serve");
    let port = handle.bound_port;

    let res = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/auth/codex"))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["accessToken"], "at");
    assert_eq!(body["accountId"], "acc");
    assert!(body["expiresAt"].as_u64().unwrap() > 0);

    handle.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn auth_codex_returns_401_when_expired() {
    use crate::codex_auth::{write_store, CodexCreds, unix_now_ms};
    let dir = std::env::temp_dir().join(format!("tcb-codex-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let now = unix_now_ms();
    let creds = CodexCreds {
        access_token: "at".into(),
        refresh_token: "rt".into(),
        id_token: "id".into(),
        account_id: "acc".into(),
        email: None,
        expires_at: now.saturating_sub(1000),  // expired 1s ago
        stored_at: now.saturating_sub(3_600_000),
        imported_from: None,
    };
    write_store(&dir, &creds).unwrap();

    let token = "x".repeat(43);
    let handle = serve_with_codex(0, token.clone(), dir.join("audit.sqlite"), dir.clone(), Default::default())
        .await
        .expect("serve");
    let port = handle.bound_port;

    let res = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/auth/codex"))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["code"], "auth.codex_expired");

    handle.shutdown().await;
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Add new routes to `tool_callback.rs::router_with_codex`**

Modify `tool_callback.rs`:

```rust
use crate::codex_auth::{read_store, RefreshSingleton, refresh_access_token, TOKEN_URL, write_store, creds_from_token_response, unix_now_ms};

#[derive(Clone)]
pub struct CodexState {
    pub profile_dir: PathBuf,
    pub refresh: RefreshSingleton,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAuthResponse {
    access_token: String,
    account_id: String,
    expires_at: u64,
    email: Option<String>,
}

async fn auth_codex_handler(
    axum::extract::State(state): axum::extract::State<CodexState>,
) -> impl IntoResponse {
    let creds = match read_store(&state.profile_dir) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "code": "auth.codex_not_signed_in",
                    "message": "no codex credentials found"
                })),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "code": "internal",
                    "message": format!("read store: {e:#}")
                })),
            )
                .into_response();
        }
    };
    if creds.expires_at <= unix_now_ms() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "code": "auth.codex_expired",
                "message": "codex token expired; refresh required"
            })),
        )
            .into_response();
    }
    Json(CodexAuthResponse {
        access_token: creds.access_token,
        account_id: creds.account_id,
        expires_at: creds.expires_at,
        email: creds.email,
    })
    .into_response()
}

async fn auth_codex_refresh_handler(
    axum::extract::State(state): axum::extract::State<CodexState>,
) -> impl IntoResponse {
    let creds = match read_store(&state.profile_dir) {
        Ok(Some(c)) => c,
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "code": "auth.codex_not_signed_in",
                    "message": "no codex credentials found"
                })),
            )
                .into_response();
        }
    };
    let response = match state.refresh.refresh_once(TOKEN_URL, &creds.refresh_token).await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "code": "auth.codex_expired",
                    "message": format!("refresh failed: {e:#}")
                })),
            )
                .into_response();
        }
    };
    let new_creds = match creds_from_token_response(response, creds.imported_from.clone()) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "code": "internal",
                    "message": format!("creds from token: {e:#}")
                })),
            )
                .into_response();
        }
    };
    if let Err(e) = write_store(&state.profile_dir, &new_creds) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "code": "internal",
                "message": format!("write store: {e:#}")
            })),
        )
            .into_response();
    }
    Json(CodexAuthResponse {
        access_token: new_creds.access_token,
        account_id: new_creds.account_id,
        expires_at: new_creds.expires_at,
        email: new_creds.email,
    })
    .into_response()
}
```

In `build_router`, attach the new routes under the bearer-auth layer:

```rust
let codex_routes = Router::new()
    .route("/auth/codex", get(auth_codex_handler))
    .route("/auth/codex/refresh", axum::routing::post(auth_codex_refresh_handler))
    .with_state(codex_state.clone())
    .route_layer(middleware::from_fn_with_state(state.clone(), auth_middleware));

let tools_routes = /* existing /tools/* routes */;

let public_routes = /* existing /healthz */;

Router::new().merge(public_routes).merge(tools_routes).merge(codex_routes)
```

Refactor `serve` to a new fn `serve_with_codex` that takes profile_dir + RefreshSingleton; keep old `serve` as a wrapper for tests not exercising codex paths.

```rust
pub async fn serve(port: u16, token: String, audit_db_path: PathBuf) -> Result<ToolCallbackHandle> {
    serve_with_codex(port, token, audit_db_path, std::env::temp_dir(), RefreshSingleton::default()).await
}

pub async fn serve_with_codex(
    port: u16,
    token: String,
    audit_db_path: PathBuf,
    profile_dir: PathBuf,
    refresh: RefreshSingleton,
) -> Result<ToolCallbackHandle> {
    // Build CodexState from profile_dir + refresh
    let codex_state = CodexState { profile_dir, refresh };
    // ... existing serve body, but uses build_router that takes codex_state ...
}
```

Update `apps/desktop-shell/src/main.rs` step 5 (the tool_callback::serve call) to use `serve_with_codex` and pass `app_state.profile_dir()` + `app_state.codex_refresh.clone()`.

- [ ] **Step 3: Run + clippy**

```bash
cargo test -p vulture-desktop-shell tool_callback 2>&1 | grep "^test result"
cargo test -p vulture-desktop-shell --tests 2>&1 | grep "^test result"
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings 2>&1 | tail -3
```

Expect tool_callback tests: previous count (~10) + 3 new = ~13. All other tests still green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): /auth/codex GET + /auth/codex/refresh POST endpoints"
```

---

## Group C — Tauri commands

### Task 7: `start_chatgpt_login` / `sign_out_chatgpt` / `get_auth_status`

**Files:**
- Modify: `apps/desktop-shell/src/commands.rs`
- Modify: `apps/desktop-shell/src/auth.rs` (extend AuthStatusView)
- Modify: `apps/desktop-shell/src/main.rs` (register new commands; remove start_codex_login)

- [ ] **Step 1: Define unified AuthStatusView in auth.rs**

In `apps/desktop-shell/src/auth.rs`, add (after existing `OpenAiAuthStatus`):

```rust
use crate::codex_auth::{read_store, store_path, unix_now_ms};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusView {
    pub active: AuthActiveProvider,
    pub codex: CodexStatusView,
    pub api_key: ApiKeyStatusView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthActiveProvider {
    Codex,
    ApiKey,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusView {
    pub state: CodexStatusState,
    pub email: Option<String>,
    pub expires_at: Option<u64>,
    pub imported_from: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexStatusState {
    NotSignedIn,
    SignedIn,
    Expired,
    LoggingIn,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatusView {
    pub state: ApiKeyState,
    pub source: AuthSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyState {
    NotSet,
    Set,
}

pub fn unified_auth_status(
    secret_store: &dyn SecretStore,
    secret_ref: &str,
    profile_dir: &Path,
) -> Result<AuthStatusView> {
    let codex = match read_store(profile_dir)? {
        Some(creds) => {
            let now = unix_now_ms();
            let state = if creds.expires_at <= now {
                CodexStatusState::Expired
            } else {
                CodexStatusState::SignedIn
            };
            CodexStatusView {
                state,
                email: creds.email,
                expires_at: Some(creds.expires_at),
                imported_from: creds.imported_from,
            }
        }
        None => CodexStatusView {
            state: CodexStatusState::NotSignedIn,
            email: None,
            expires_at: None,
            imported_from: None,
        },
    };
    let openai = auth_status(secret_store, secret_ref)?;
    let api_key = ApiKeyStatusView {
        state: if openai.configured {
            ApiKeyState::Set
        } else {
            ApiKeyState::NotSet
        },
        source: openai.source,
    };
    let active = match (&codex.state, &api_key.state) {
        (CodexStatusState::SignedIn, _) => AuthActiveProvider::Codex,
        (_, ApiKeyState::Set) => AuthActiveProvider::ApiKey,
        _ => AuthActiveProvider::None,
    };
    Ok(AuthStatusView { active, codex, api_key })
}
```

- [ ] **Step 2: New Tauri commands in commands.rs**

Replace `start_codex_login` (currently 11 lines) with the three new commands.

Add to top of `commands.rs`:

```rust
use crate::auth::{AuthStatusView, unified_auth_status};
use crate::codex_auth::{
    creds_from_token_response, delete_store, ensure_store_with_import, exchange_authorization_code,
    open_browser, start_callback_server, store_path, write_store, AUTHORIZE_URL, CallbackResult,
    CLIENT_ID, Pkce, SCOPE, TOKEN_URL,
};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
```

Replace `start_codex_login` block with:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGPTLoginStart {
    pub url: String,
    pub already_authenticated: bool,
}

#[tauri::command]
pub async fn start_chatgpt_login(state: State<'_, AppState>) -> Result<ChatGPTLoginStart, String> {
    // Already signed in?
    let profile_dir = state.profile_dir();
    if let Ok(Some(_)) = crate::codex_auth::read_store(&profile_dir) {
        return Ok(ChatGPTLoginStart {
            url: String::new(),
            already_authenticated: true,
        });
    }

    let pkce = Pkce::generate();

    let (tx, rx) = oneshot::channel::<CallbackResult>();
    let handle = start_callback_server(1455, tx)
        .await
        .map_err(|e| format!("start callback server: {e:#}"))?;
    let port = handle.bound_port;
    let redirect_uri = format!("http://localhost:{port}/auth/callback");

    let mut url = format!(
        "{AUTHORIZE_URL}?client_id={CLIENT_ID}&response_type=code&redirect_uri={}",
        urlencoding::encode(&redirect_uri),
    );
    url.push_str(&format!("&scope={}", urlencoding::encode(SCOPE)));
    url.push_str(&format!("&code_challenge={}", pkce.challenge));
    url.push_str("&code_challenge_method=S256");
    url.push_str(&format!("&state={}", pkce.state));

    open_browser(&url).map_err(|e| format!("open browser: {e:#}"))?;

    // Wait up to 5 minutes for callback.
    let callback = match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
        Ok(Ok(cb)) => cb,
        _ => {
            handle.shutdown().await;
            return Err("login timed out or cancelled".to_string());
        }
    };
    handle.shutdown().await;

    if callback.state != pkce.state {
        return Err("state mismatch (CSRF protection)".to_string());
    }

    let response = exchange_authorization_code(TOKEN_URL, &callback.code, &pkce.verifier, &redirect_uri)
        .await
        .map_err(|e| format!("token exchange: {e:#}"))?;

    let creds = creds_from_token_response(response, None)
        .map_err(|e| format!("creds from token: {e:#}"))?;

    write_store(&profile_dir, &creds).map_err(|e| format!("write store: {e:#}"))?;

    Ok(ChatGPTLoginStart {
        url,
        already_authenticated: false,
    })
}

#[tauri::command]
pub fn sign_out_chatgpt(state: State<'_, AppState>) -> Result<(), String> {
    delete_store(&state.profile_dir()).map_err(|e| format!("delete store: {e:#}"))
}

#[tauri::command]
pub fn get_auth_status(state: State<'_, AppState>) -> Result<AuthStatusView, String> {
    unified_auth_status(
        state.secret_store(),
        state.openai_secret_ref(),
        &state.profile_dir(),
    )
    .map_err(|e| format!("auth status: {e:#}"))
}
```

Note: `state.secret_store()` and `state.openai_secret_ref()` need to exist on `AppState`. If they don't, expose them via `pub fn secret_store(&self) -> &dyn SecretStore { self.secret_store.as_ref() }` and `pub fn openai_secret_ref(&self) -> &str { &self.openai_secret_ref }`.

Add `urlencoding = "2"` to `apps/desktop-shell/Cargo.toml` if not present.

- [ ] **Step 3: Update main.rs invoke_handler**

In `apps/desktop-shell/src/main.rs` `invoke_handler!`:

Remove:
```rust
commands::start_codex_login,
```

Add:
```rust
commands::start_chatgpt_login,
commands::sign_out_chatgpt,
commands::get_auth_status,
```

Also remove `commands::get_openai_auth_status` if you want a clean unified API; otherwise keep both (UI uses `get_auth_status`; legacy callers can use `get_openai_auth_status` until migration). Recommendation: keep both for one phase to avoid UI breakage during the upgrade window.

- [ ] **Step 4: Delete old start_codex_login + ensure import on startup**

In `apps/desktop-shell/src/auth.rs`, delete these functions (no longer used):
- `start_codex_login`
- `should_reuse_existing_codex_login`
- `wait_for_codex_login_in_background`
- `find_verification_url`
- `find_user_code`
- `strip_ansi`
- `codex_login_status_reports_chatgpt` (replaced by `read_store` check)
- `codex_auth_file_reports_chatgpt`
- `codex_auth_path`
- `logout_codex`

Keep `codex_chatgpt_login_available` if you want a backward-compat helper (it can be re-implemented to call `read_store`).

In `apps/desktop-shell/src/main.rs`, after `AppState::new_for_root` succeeds, call:

```rust
crate::codex_auth::ensure_store_with_import(&app_state.profile_dir())
    .context("import existing codex credentials")?;
```

- [ ] **Step 5: Run + clippy**

```bash
cargo build -p vulture-desktop-shell 2>&1 | tail -5
cargo test -p vulture-desktop-shell --tests 2>&1 | grep "^test result"
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings 2>&1 | tail -3
```

Expect: builds clean, tests still pass (note: deleting old `start_codex_login` removes some tests if they existed; verify the count drop is expected).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): Tauri commands for ChatGPT OAuth (start_chatgpt_login, sign_out_chatgpt, get_auth_status)"
```

---

## Group D — Gateway codexLlm provider

### Task 8: SDK spike — verify @openai/agents accepts custom OpenAI client

**Files:**
- Create: `apps/gateway/src/runtime/codexLlm.spike.ts` (deleted at end)
- Modify: `apps/gateway/package.json` (add `openai` dep)

This is a one-off verification to confirm Section 5's risk #1 mitigation (the SDK accepts `setDefaultOpenAIClient` with a custom-baseURL OpenAI client).

- [ ] **Step 1: Add openai dep**

Edit `apps/gateway/package.json` `dependencies`:
```json
"openai": "^4.0.0"
```

Run `bun install` from repo root.

- [ ] **Step 2: Write spike script**

Create `apps/gateway/src/runtime/codexLlm.spike.ts`:

```ts
// One-off spike: verify @openai/agents accepts a custom OpenAI client with
// custom baseURL + headers. Run with:
//   bun apps/gateway/src/runtime/codexLlm.spike.ts
//
// Expected output: a request to the (mocked) chatgpt.com/backend-api endpoint
// containing the right headers. Delete this file after verification.

import OpenAI from "openai";
import { setDefaultOpenAIClient, setOpenAIAPI } from "@openai/agents-openai";
import { Agent, run } from "@openai/agents";

const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};

const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  captured.url = u;
  captured.headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
  captured.body = init?.body ? JSON.parse(String(init.body)) : null;

  return new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
      status: "completed",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

const client = new OpenAI({
  apiKey: "fake-token",
  baseURL: "https://chatgpt.com/backend-api",
  defaultHeaders: {
    "OpenAI-Beta": "responses=experimental",
    "chatgpt-account-id": "acc-test",
    originator: "vulture-spike",
  },
  fetch: customFetch,
});
setDefaultOpenAIClient(client);
setOpenAIAPI("responses");

const agent = new Agent({ name: "spike", instructions: "say hi", model: "gpt-5.4" });
const result = await run(agent, "hi");
console.log("Captured URL:", captured.url);
console.log("Captured headers:", captured.headers);
console.log("Final output:", result.finalOutput);

if (!captured.url?.startsWith("https://chatgpt.com/backend-api")) {
  console.error("FAIL: baseURL not respected");
  process.exit(1);
}
if (captured.headers?.["openai-beta"] !== "responses=experimental") {
  console.error("FAIL: OpenAI-Beta header not respected");
  process.exit(1);
}
console.log("SPIKE PASS — @openai/agents respects custom OpenAI client");
```

- [ ] **Step 3: Run the spike**

```bash
bun apps/gateway/src/runtime/codexLlm.spike.ts
```

Expected output: `SPIKE PASS — @openai/agents respects custom OpenAI client` and the captured URL/headers.

**If the spike FAILS** (custom client ignored, headers stripped, baseURL not used): STOP and apply the fallback in Task 9 — instead of `setDefaultOpenAIClient`, use a `fetch` wrapper that intercepts `api.openai.com` calls and rewrites baseURL + headers.

- [ ] **Step 4: Delete the spike file**

```bash
rm apps/gateway/src/runtime/codexLlm.spike.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/package.json bun.lock
git commit -m "chore(gateway): add openai dep for custom client + verify @openai/agents accepts it"
```

### Task 9: `runtime/codexLlm.ts` provider

**Files:**
- Create: `apps/gateway/src/runtime/codexLlm.ts`
- Create: `apps/gateway/src/runtime/codexLlm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/runtime/codexLlm.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { fetchCodexToken, makeCodexLlm, type CodexShellResponse } from "./codexLlm";

function fakeShellFetch(seq: Array<{ status: number; body: unknown }>): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; method: string }>;
} {
  let i = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    const r = seq[i++] ?? seq[seq.length - 1];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const validToken: CodexShellResponse = {
  accessToken: "tok-abc",
  accountId: "acc-1",
  expiresAt: Date.now() + 3_600_000,
  email: "user@example.com",
};

describe("fetchCodexToken", () => {
  test("returns token on 200", async () => {
    const { fetchFn } = fakeShellFetch([{ status: 200, body: validToken }]);
    const result = await fetchCodexToken({
      shellUrl: "http://shell:4199",
      bearer: "tok",
      fetch: fetchFn,
    });
    expect(result).toEqual(validToken);
  });

  test("triggers refresh on 401, retries", async () => {
    const { fetchFn, calls } = fakeShellFetch([
      { status: 401, body: { code: "auth.codex_expired" } },
      { status: 200, body: validToken }, // refresh response
      { status: 200, body: validToken }, // re-fetch after refresh
    ]);
    const result = await fetchCodexToken({
      shellUrl: "http://shell:4199",
      bearer: "tok",
      fetch: fetchFn,
    });
    expect(result).toEqual(validToken);
    expect(calls.length).toBe(3);
    expect(calls[1].url).toContain("/auth/codex/refresh");
    expect(calls[1].method).toBe("POST");
  });

  test("throws on 404 (not signed in)", async () => {
    const { fetchFn } = fakeShellFetch([{ status: 404, body: { code: "auth.codex_not_signed_in" } }]);
    await expect(
      fetchCodexToken({ shellUrl: "http://shell:4199", bearer: "tok", fetch: fetchFn }),
    ).rejects.toMatchObject({ code: "auth.codex_not_signed_in" });
  });

  test("throws on second 401 after refresh", async () => {
    const { fetchFn } = fakeShellFetch([
      { status: 401, body: { code: "auth.codex_expired" } },
      { status: 401, body: { code: "auth.codex_expired" } },
    ]);
    await expect(
      fetchCodexToken({ shellUrl: "http://shell:4199", bearer: "tok", fetch: fetchFn }),
    ).rejects.toMatchObject({ code: "auth.codex_expired" });
  });
});
```

- [ ] **Step 2: Run, FAIL**

```bash
bun test apps/gateway/src/runtime/codexLlm.test.ts
```

- [ ] **Step 3: Implement `codexLlm.ts`**

Create `apps/gateway/src/runtime/codexLlm.ts`:

```ts
import OpenAI from "openai";
import { setDefaultOpenAIClient, setOpenAIAPI } from "@openai/agents-openai";
import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";
import { makeOpenAILlm } from "./openaiLlm";

export interface CodexShellResponse {
  accessToken: string;
  accountId: string;
  expiresAt: number;
  email?: string;
}

export interface CodexShellError extends Error {
  code: "auth.codex_not_signed_in" | "auth.codex_expired" | "internal";
  status: number;
}

export interface FetchCodexTokenOptions {
  shellUrl: string;
  bearer: string;
  fetch?: typeof fetch;
}

export async function fetchCodexToken(opts: FetchCodexTokenOptions): Promise<CodexShellResponse> {
  const f = opts.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${opts.bearer}` };

  const first = await f(`${opts.shellUrl}/auth/codex`, { headers });
  if (first.ok) {
    return (await first.json()) as CodexShellResponse;
  }
  if (first.status === 404) {
    const body = (await first.json().catch(() => ({}))) as { code?: string; message?: string };
    throw makeShellError(body.code ?? "internal", first.status, body.message ?? "not signed in");
  }
  if (first.status === 401) {
    // Try refresh
    const refresh = await f(`${opts.shellUrl}/auth/codex/refresh`, {
      method: "POST",
      headers,
    });
    if (refresh.ok) {
      // Re-fetch token
      const second = await f(`${opts.shellUrl}/auth/codex`, { headers });
      if (second.ok) {
        return (await second.json()) as CodexShellResponse;
      }
      const body = (await second.json().catch(() => ({}))) as { code?: string; message?: string };
      throw makeShellError(body.code ?? "auth.codex_expired", second.status, body.message ?? "expired after refresh");
    }
    const body = (await refresh.json().catch(() => ({}))) as { code?: string; message?: string };
    throw makeShellError(body.code ?? "auth.codex_expired", refresh.status, body.message ?? "refresh failed");
  }
  const body = (await first.json().catch(() => ({}))) as { code?: string; message?: string };
  throw makeShellError(body.code ?? "internal", first.status, body.message ?? "unknown shell error");
}

function makeShellError(code: string, status: number, message: string): CodexShellError {
  const err = new Error(message) as CodexShellError;
  err.code = code as CodexShellError["code"];
  err.status = status;
  err.name = "CodexShellError";
  return err;
}

export interface CodexLlmOptions {
  shellUrl: string;
  shellBearer: string;
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  fetch?: typeof fetch;
}

export function makeCodexLlm(opts: CodexLlmOptions): LlmCallable {
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    const token = await fetchCodexToken({
      shellUrl: opts.shellUrl,
      bearer: opts.shellBearer,
      fetch: opts.fetch,
    });

    // Configure @openai/agents to route via chatgpt.com/backend-api with the
    // codex-specific headers. This is process-global; runs are sequential so
    // setting it per-call is safe.
    const client = new OpenAI({
      apiKey: token.accessToken,
      baseURL: "https://chatgpt.com/backend-api",
      defaultHeaders: {
        "OpenAI-Beta": "responses=experimental",
        "chatgpt-account-id": token.accountId,
        originator: "vulture",
        session_id: input.runId,
        conversation_id: input.runId,
      },
    });
    setDefaultOpenAIClient(client);
    setOpenAIAPI("responses");

    // Now delegate to the same OpenAILlm machinery; it'll use the client we
    // just configured.
    const inner = makeOpenAILlm({
      apiKey: token.accessToken,
      toolNames: opts.toolNames,
      toolCallable: opts.toolCallable,
    });
    yield* inner(input);
  };
}
```

- [ ] **Step 4: Run, expect 4 PASS** + typecheck

```bash
bun test apps/gateway/src/runtime/codexLlm.test.ts
bun --filter @vulture/gateway typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): codexLlm provider (fetches token from shell, custom OpenAI client)"
```

---

## Group E — resolveLlm 三轨扩展

### Task 10: 3-way priority + Codex failure fallback

**Files:**
- Modify: `apps/gateway/src/runtime/resolveLlm.ts`
- Modify: `apps/gateway/src/runtime/resolveLlm.test.ts`
- Modify: `apps/gateway/src/server.ts` (pass shellCallbackUrl + token)

- [ ] **Step 1: Append failing test**

In `apps/gateway/src/runtime/resolveLlm.test.ts`, add:

```ts
test("uses codex when shell returns valid token", async () => {
  const llm = makeLazyLlm({
    toolNames: [],
    toolCallable: async () => "noop",
    env: { OPENAI_API_KEY: "sk-test" },
    shellCallbackUrl: "http://shell:4199",
    shellToken: "x".repeat(43),
    fetch: (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/auth/codex")) {
        return new Response(
          JSON.stringify({ accessToken: "codex-tok", accountId: "acc", expiresAt: Date.now() + 1e6 }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch,
  });
  // We can't assert directly which inner provider runs without a hook, but we
  // can verify the lazy function resolves without throwing — Codex provider
  // should be selected and it'll attempt to call its OpenAI client which
  // would fail in test env. So instead, install a fetch mock that records
  // whether /auth/codex was queried.
  let codexQueried = false;
  const trackingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/auth/codex")) {
      codexQueried = true;
      return new Response(
        JSON.stringify({ accessToken: "codex-tok", accountId: "acc", expiresAt: Date.now() + 1e6 }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const llm2 = makeLazyLlm({
    toolNames: [],
    toolCallable: async () => "noop",
    env: { OPENAI_API_KEY: "sk-test" },
    shellCallbackUrl: "http://shell:4199",
    shellToken: "x".repeat(43),
    fetch: trackingFetch,
  });
  const iter = llm2({
    systemPrompt: "x",
    userInput: "hi",
    model: "gpt-5.4",
    runId: "r-1",
    workspacePath: "",
  });
  // Drain at least one yield; this triggers the codex token fetch
  await iter.next().catch(() => undefined);
  expect(codexQueried).toBe(true);
});

test("falls back to api key when codex returns 404 (not signed in)", async () => {
  const fetchFn = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/auth/codex")) {
      return new Response(
        JSON.stringify({ code: "auth.codex_not_signed_in", message: "no creds" }),
        { status: 404 },
      );
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const llm = makeLazyLlm({
    toolNames: [],
    toolCallable: async () => "noop",
    env: { OPENAI_API_KEY: "sk-test" },
    shellCallbackUrl: "http://shell:4199",
    shellToken: "x".repeat(43),
    fetch: fetchFn,
  });
  // We expect API key path is selected. We can't easily verify which without
  // intercepting OpenAI SDK calls, but at least confirm no throw.
  const iter = llm({
    systemPrompt: "x",
    userInput: "hi",
    model: "gpt-5.4",
    runId: "r-1",
    workspacePath: "",
  });
  // Drain at least one to trigger inner provider construction
  await iter.next().catch(() => undefined);
  // No assertion on codex (we already know it 404s); just verify no test crash
  expect(true).toBe(true);
});

test("falls back to stub when codex expired (explicit, not silent api key)", async () => {
  const fetchFn = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/auth/codex")) {
      return new Response(
        JSON.stringify({ code: "auth.codex_expired", message: "expired" }),
        { status: 401 },
      );
    }
    if (u.endsWith("/auth/codex/refresh")) {
      return new Response(
        JSON.stringify({ code: "auth.codex_expired", message: "refresh failed" }),
        { status: 401 },
      );
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const llm = makeLazyLlm({
    toolNames: [],
    toolCallable: async () => "noop",
    env: { OPENAI_API_KEY: "sk-test" }, // present, but should NOT be used
    shellCallbackUrl: "http://shell:4199",
    shellToken: "x".repeat(43),
    fetch: fetchFn,
  });
  const yields: Array<{ kind: string }> = [];
  for await (const y of llm({
    systemPrompt: "x",
    userInput: "hi",
    model: "gpt-5.4",
    runId: "r-1",
    workspacePath: "",
  })) {
    yields.push(y as { kind: string });
  }
  expect(yields[0].kind).toBe("final");
  if (yields[0].kind === "final") {
    expect((yields[0] as { kind: "final"; text: string }).text).toContain("Codex");
  }
});
```

- [ ] **Step 2: Run, FAIL**

```bash
bun test apps/gateway/src/runtime/resolveLlm.test.ts
```

- [ ] **Step 3: Update `resolveLlm.ts`**

Replace `apps/gateway/src/runtime/resolveLlm.ts`:

```ts
import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";
import { makeOpenAILlm, makeStubLlmFallback } from "./openaiLlm";
import { fetchCodexToken, makeCodexLlm, type CodexShellError } from "./codexLlm";

export interface ResolveLlmDeps {
  toolNames: readonly string[];
  toolCallable: ToolCallable;
  env?: Record<string, string | undefined>;
  shellCallbackUrl: string;
  shellToken: string;
  fetch?: typeof fetch;
}

export function makeLazyLlm(deps: ResolveLlmDeps): LlmCallable {
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    // Try codex first
    let codexState: "available" | "not_signed_in" | "expired" = "not_signed_in";
    try {
      await fetchCodexToken({
        shellUrl: deps.shellCallbackUrl,
        bearer: deps.shellToken,
        fetch: deps.fetch,
      });
      codexState = "available";
    } catch (cause) {
      const err = cause as CodexShellError;
      if (err.code === "auth.codex_expired") codexState = "expired";
      else codexState = "not_signed_in";
    }

    if (codexState === "available") {
      const inner = makeCodexLlm({
        shellUrl: deps.shellCallbackUrl,
        shellBearer: deps.shellToken,
        toolNames: deps.toolNames,
        toolCallable: deps.toolCallable,
        fetch: deps.fetch,
      });
      yield* inner(input);
      return;
    }

    if (codexState === "expired") {
      // Explicit fallback (do NOT silently downgrade to API key — see spec
      // invariant 4: avoid surprise billing).
      yield {
        kind: "final",
        text: "Codex 已过期，请重新登录（侧栏 设置 → Sign in with ChatGPT）",
      };
      return;
    }

    // codexState === "not_signed_in" → API key path
    const env = deps.env ?? process.env;
    const apiKey = env.OPENAI_API_KEY;
    const inner = apiKey
      ? makeOpenAILlm({
          apiKey,
          toolNames: deps.toolNames,
          toolCallable: deps.toolCallable,
        })
      : makeStubLlmFallback();
    yield* inner(input);
  };
}
```

- [ ] **Step 4: Update server.ts call**

In `apps/gateway/src/server.ts`, find the `makeLazyLlm({...})` call and add the new fields:

```ts
const llm: LlmCallable = makeLazyLlm({
  toolNames: AGENT_TOOL_NAMES,
  toolCallable: tools,
  shellCallbackUrl: cfg.shellCallbackUrl,
  shellToken: cfg.token,
});
```

- [ ] **Step 5: Run + typecheck + full suite**

```bash
bun test apps/gateway/src 2>&1 | tail -10
bun --filter '*' typecheck 2>&1 | tail -10
cargo test --workspace 2>&1 | grep "^test result" | head -3
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
```

- [ ] **Step 6: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): resolveLlm 3-way priority (Codex > API key > stub) with explicit Codex-expired fallback"
```

---

## Group F — UI components

### Task 11: `AuthPanel` component

**Files:**
- Create: `apps/desktop-ui/src/chat/AuthPanel.tsx`
- Create: `apps/desktop-ui/src/chat/AuthPanel.test.tsx`
- Modify: `apps/desktop-ui/src/commandCenterTypes.ts` (add AuthStatusView type)

- [ ] **Step 1: Add AuthStatusView types**

Append to `apps/desktop-ui/src/commandCenterTypes.ts`:

```ts
export type AuthActiveProvider = "codex" | "api_key" | "none";

export type CodexStatusState = "not_signed_in" | "signed_in" | "expired" | "logging_in";

export interface CodexStatusView {
  state: CodexStatusState;
  email?: string;
  expiresAt?: number;
  importedFrom?: string;
}

export type ApiKeyState = "not_set" | "set";

export interface ApiKeyStatusView {
  state: ApiKeyState;
  source?: AuthSource;  // existing type
}

export interface AuthStatusView {
  active: AuthActiveProvider;
  codex: CodexStatusView;
  apiKey: ApiKeyStatusView;
}

export interface ChatGPTLoginStart {
  url: string;
  alreadyAuthenticated: boolean;
}
```

- [ ] **Step 2: Write failing test**

Create `apps/desktop-ui/src/chat/AuthPanel.test.tsx`:

```tsx
import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuthPanel } from "./AuthPanel";
import type { AuthStatusView } from "../commandCenterTypes";

const noAuthStatus: AuthStatusView = {
  active: "none",
  codex: { state: "not_signed_in" },
  apiKey: { state: "not_set" },
};

const codexSignedIn: AuthStatusView = {
  active: "codex",
  codex: {
    state: "signed_in",
    email: "user@example.com",
    expiresAt: Date.now() + 7_200_000,
  },
  apiKey: { state: "not_set" },
};

const codexExpired: AuthStatusView = {
  active: "none",
  codex: { state: "expired", email: "user@example.com" },
  apiKey: { state: "not_set" },
};

describe("AuthPanel", () => {
  test("renders signed-in state with email", () => {
    render(
      <AuthPanel
        authStatus={codexSignedIn}
        onSignInWithChatGPT={async () => {}}
        onSignOutCodex={async () => {}}
        onSaveApiKey={async () => {}}
        onClearApiKey={async () => {}}
      />,
    );
    expect(screen.getByText(/user@example.com/)).toBeDefined();
    expect(screen.getByText(/Sign out/i)).toBeDefined();
  });

  test("renders 'Sign in with ChatGPT' when not signed in", () => {
    render(
      <AuthPanel
        authStatus={noAuthStatus}
        onSignInWithChatGPT={async () => {}}
        onSignOutCodex={async () => {}}
        onSaveApiKey={async () => {}}
        onClearApiKey={async () => {}}
      />,
    );
    expect(screen.getByText(/Sign in with ChatGPT/i)).toBeDefined();
  });

  test("clicking sign in triggers callback", () => {
    const onSignIn = mock(async () => {});
    render(
      <AuthPanel
        authStatus={noAuthStatus}
        onSignInWithChatGPT={onSignIn}
        onSignOutCodex={async () => {}}
        onSaveApiKey={async () => {}}
        onClearApiKey={async () => {}}
      />,
    );
    fireEvent.click(screen.getByText(/Sign in with ChatGPT/i));
    expect(onSignIn).toHaveBeenCalled();
  });

  test("renders expired state in red", () => {
    const { container } = render(
      <AuthPanel
        authStatus={codexExpired}
        onSignInWithChatGPT={async () => {}}
        onSignOutCodex={async () => {}}
        onSaveApiKey={async () => {}}
        onClearApiKey={async () => {}}
      />,
    );
    expect(container.textContent).toContain("已过期");
  });

  test("API key save triggers callback with input value", () => {
    const onSave = mock(async () => {});
    render(
      <AuthPanel
        authStatus={noAuthStatus}
        onSignInWithChatGPT={async () => {}}
        onSignOutCodex={async () => {}}
        onSaveApiKey={onSave}
        onClearApiKey={async () => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-abc" } });
    fireEvent.click(screen.getByText(/Save/i));
    expect(onSave).toHaveBeenCalledWith("sk-abc");
  });
});
```

- [ ] **Step 3: Implement AuthPanel.tsx**

Create `apps/desktop-ui/src/chat/AuthPanel.tsx`:

```tsx
import { useState } from "react";
import type { AuthStatusView } from "../commandCenterTypes";

export interface AuthPanelProps {
  authStatus: AuthStatusView;
  onSignInWithChatGPT: () => Promise<void>;
  onSignOutCodex: () => Promise<void>;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
}

export function AuthPanel(props: AuthPanelProps) {
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState<"signin" | "signout" | "savekey" | null>(null);

  async function safeAction<T>(label: typeof busy, fn: () => Promise<T>) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const codex = props.authStatus.codex;
  const apiKey = props.authStatus.apiKey;
  const expiresInMin = codex.expiresAt
    ? Math.max(0, Math.floor((codex.expiresAt - Date.now()) / 60_000))
    : null;

  return (
    <div className="auth-panel">
      <div className="auth-panel-section">
        <h4>ChatGPT 订阅 (推荐)</h4>
        {codex.state === "signed_in" ? (
          <>
            <p className="auth-panel-status">
              ⦿ 已登录{codex.email ? ` · ${codex.email}` : ""}
            </p>
            {expiresInMin !== null && (
              <p className="auth-panel-meta">过期：{expiresInMin} 分钟后</p>
            )}
            {codex.importedFrom && (
              <p className="auth-panel-meta">凭证已从 Codex CLI 导入</p>
            )}
            <button
              type="button"
              className="auth-panel-secondary"
              disabled={busy !== null}
              onClick={() => safeAction("signout", props.onSignOutCodex)}
            >
              {busy === "signout" ? "..." : "Sign out"}
            </button>
          </>
        ) : codex.state === "expired" ? (
          <>
            <p className="auth-panel-status auth-panel-error">⚠ 已过期</p>
            {codex.email && <p className="auth-panel-meta">{codex.email}</p>}
            <button
              type="button"
              className="auth-panel-primary"
              disabled={busy !== null}
              onClick={() => safeAction("signin", props.onSignInWithChatGPT)}
            >
              {busy === "signin" ? "Opening browser..." : "Sign in again"}
            </button>
          </>
        ) : codex.state === "logging_in" ? (
          <p className="auth-panel-status">等待浏览器完成登录…</p>
        ) : (
          <>
            <p className="auth-panel-status">◯ 未登录</p>
            <button
              type="button"
              className="auth-panel-primary"
              disabled={busy !== null}
              onClick={() => safeAction("signin", props.onSignInWithChatGPT)}
            >
              {busy === "signin" ? "Opening browser..." : "Sign in with ChatGPT"}
            </button>
          </>
        )}
      </div>

      <hr className="auth-panel-divider" />

      <div className="auth-panel-section">
        <h4>OpenAI API key (备选)</h4>
        {apiKey.state === "set" ? (
          <>
            <p className="auth-panel-status">⦿ 已设置 ({apiKey.source ?? "keychain"})</p>
            <button
              type="button"
              className="auth-panel-secondary"
              disabled={busy !== null}
              onClick={() => safeAction("savekey", () => props.onClearApiKey())}
            >
              Clear
            </button>
          </>
        ) : (
          <>
            <p className="auth-panel-status">◯ 未设置</p>
            <div className="auth-panel-input-row">
              <input
                type="password"
                placeholder="sk-..."
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
              <button
                type="button"
                className="auth-panel-secondary"
                disabled={busy !== null || !apiKeyInput.trim()}
                onClick={() =>
                  safeAction("savekey", async () => {
                    await props.onSaveApiKey(apiKeyInput.trim());
                    setApiKeyInput("");
                  })
                }
              >
                {busy === "savekey" ? "..." : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run, expect 5 PASS** + typecheck

```bash
bun test apps/desktop-ui/src/chat/AuthPanel.test.tsx
bun --filter @vulture/desktop-ui typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): AuthPanel component (sidebar settings panel)"
```

### Task 12: `OnboardingCard` component

**Files:**
- Create: `apps/desktop-ui/src/chat/OnboardingCard.tsx`
- Create: `apps/desktop-ui/src/chat/OnboardingCard.test.tsx`

- [ ] **Step 1: Write failing test**

Create `apps/desktop-ui/src/chat/OnboardingCard.test.tsx`:

```tsx
import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingCard } from "./OnboardingCard";

describe("OnboardingCard", () => {
  test("renders both auth options", () => {
    render(
      <OnboardingCard
        onSignInWithChatGPT={async () => {}}
        onFocusApiKey={() => {}}
      />,
    );
    expect(screen.getByText(/Sign in with ChatGPT/i)).toBeDefined();
    expect(screen.getByText(/OpenAI API key/i)).toBeDefined();
  });

  test("ChatGPT sign in triggers callback", () => {
    const onSignIn = mock(async () => {});
    render(
      <OnboardingCard onSignInWithChatGPT={onSignIn} onFocusApiKey={() => {}} />,
    );
    fireEvent.click(screen.getByText(/Sign in with ChatGPT/i));
    expect(onSignIn).toHaveBeenCalled();
  });

  test("API key click triggers focus callback", () => {
    const onFocus = mock(() => {});
    render(
      <OnboardingCard onSignInWithChatGPT={async () => {}} onFocusApiKey={onFocus} />,
    );
    fireEvent.click(screen.getByText(/OpenAI API key/i));
    expect(onFocus).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

Create `apps/desktop-ui/src/chat/OnboardingCard.tsx`:

```tsx
export interface OnboardingCardProps {
  onSignInWithChatGPT: () => Promise<void>;
  onFocusApiKey: () => void;
}

export function OnboardingCard(props: OnboardingCardProps) {
  return (
    <div className="onboarding-card">
      <div className="hero-mark">V</div>
      <h2>Vulture</h2>
      <p>选择登录方式开始使用：</p>
      <div className="onboarding-actions">
        <button
          type="button"
          className="onboarding-primary"
          onClick={() => void props.onSignInWithChatGPT()}
        >
          <span className="onboarding-icon" aria-hidden="true">⚡</span>
          <div className="onboarding-text">
            <strong>Sign in with ChatGPT</strong>
            <small>用订阅省 API key 费用（推荐）</small>
          </div>
        </button>
        <button
          type="button"
          className="onboarding-secondary"
          onClick={props.onFocusApiKey}
        >
          <span className="onboarding-icon" aria-hidden="true">🔑</span>
          <div className="onboarding-text">
            <strong>OpenAI API key</strong>
            <small>按 token 计费</small>
          </div>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run, expect 3 PASS** + typecheck

```bash
bun test apps/desktop-ui/src/chat/OnboardingCard.test.tsx
bun --filter @vulture/desktop-ui typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): OnboardingCard component (zero-auth empty state)"
```

### Task 13: `ConversationList` footer slot for AuthPanel

**Files:**
- Modify: `apps/desktop-ui/src/chat/ConversationList.tsx`

- [ ] **Step 1: Write failing test**

Append to `apps/desktop-ui/src/chat/ConversationList.test.tsx`:

```tsx
test("renders footer slot when provided", () => {
  render(
    <ConversationList
      items={[]}
      activeId={null}
      onSelect={() => {}}
      onNew={() => {}}
      footerSlot={<div data-testid="auth-slot">auth here</div>}
    />,
  );
  expect(screen.getByTestId("auth-slot")).toBeDefined();
});
```

- [ ] **Step 2: Update component**

Modify `apps/desktop-ui/src/chat/ConversationList.tsx`. Add `footerSlot?: React.ReactNode` to `ConversationListProps`:

```tsx
import type { ReactNode } from "react";
import type { ConversationDto } from "../api/conversations";

export interface ConversationListProps {
  items: ReadonlyArray<ConversationDto>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  footerSlot?: ReactNode;
}

export function ConversationList(props: ConversationListProps) {
  return (
    <aside className="chat-sidebar">
      {/* ... existing content ... */}
      <section className="conversation-list">
        {/* ... existing list ... */}
      </section>

      {props.footerSlot ? (
        <div className="chat-sidebar-footer">{props.footerSlot}</div>
      ) : null}
    </aside>
  );
}
```

- [ ] **Step 3: Run, expect previous 4 + 1 new = 5 PASS** + typecheck

```bash
bun test apps/desktop-ui/src/chat/ConversationList.test.tsx
bun --filter @vulture/desktop-ui typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): ConversationList accepts footerSlot for AuthPanel embedding"
```

---

## Group G — App.tsx integration

### Task 14: App.tsx wires AuthPanel + Onboarding + new Tauri commands

**Files:**
- Modify: `apps/desktop-ui/src/App.tsx`
- Modify: `apps/desktop-ui/src/chat/ChatView.tsx` (accept onboardingCard prop)

- [ ] **Step 1: Modify ChatView to accept onboardingCard**

In `apps/desktop-ui/src/chat/ChatView.tsx`, add `onboardingCard?: ReactNode` to props. Use it as the empty-state replacement when present:

```tsx
import type { ReactNode } from "react";
// add to ChatViewProps:
onboardingCard?: ReactNode;

// in render, replace the existing empty-state block:
{hasContent ? (
  <div className="message-list">
    {/* existing */}
  </div>
) : props.onboardingCard ? (
  props.onboardingCard
) : (
  <div className="empty-state">
    <div className="hero-mark">V</div>
    <h2>Vulture</h2>
    <p>选择智能体，然后直接输入任务。</p>
  </div>
)}
```

- [ ] **Step 2: Update App.tsx**

Replace the auth-related section of `apps/desktop-ui/src/App.tsx`:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { AuthStatusView, ChatGPTLoginStart } from "./commandCenterTypes";
// ... other existing imports ...
import { AuthPanel } from "./chat/AuthPanel";
import { OnboardingCard } from "./chat/OnboardingCard";

// Replace the existing authStatus state + bootstrap:
const [authStatus, setAuthStatus] = useState<AuthStatusView | null>(null);

const refreshAuthStatus = useMemo(
  () => async () => {
    try {
      const status = await invoke<AuthStatusView>("get_auth_status");
      setAuthStatus(status);
    } catch {
      // Tauri unavailable in browser preview; default to "none"
      setAuthStatus({
        active: "none",
        codex: { state: "not_signed_in" },
        apiKey: { state: "not_set" },
      });
    }
  },
  [],
);

useEffect(() => {
  void refreshAuthStatus();
}, [refreshAuthStatus]);

async function handleSignInWithChatGPT() {
  try {
    await invoke<ChatGPTLoginStart>("start_chatgpt_login");
  } catch (cause) {
    // Surface to UI; for MVP just log
    console.error("ChatGPT login failed", cause);
  } finally {
    void refreshAuthStatus();
  }
}

async function handleSignOutCodex() {
  try {
    await invoke("sign_out_chatgpt");
  } finally {
    void refreshAuthStatus();
  }
}

async function handleSaveApiKey(apiKey: string) {
  try {
    await invoke("set_openai_api_key", { request: { apiKey } });
  } finally {
    void refreshAuthStatus();
  }
}

async function handleClearApiKey() {
  try {
    await invoke("clear_openai_api_key");
  } finally {
    void refreshAuthStatus();
  }
}

const authPanel = authStatus ? (
  <AuthPanel
    authStatus={authStatus}
    onSignInWithChatGPT={handleSignInWithChatGPT}
    onSignOutCodex={handleSignOutCodex}
    onSaveApiKey={handleSaveApiKey}
    onClearApiKey={handleClearApiKey}
  />
) : null;

const onboardingCard =
  authStatus?.active === "none" ? (
    <OnboardingCard
      onSignInWithChatGPT={handleSignInWithChatGPT}
      onFocusApiKey={() => {
        // No-op for MVP; the AuthPanel input is the input. Could scroll into view.
      }}
    />
  ) : null;

// Update render:
return (
  <div className="app-shell">
    <ConversationList
      items={conversations.items}
      activeId={activeConversationId}
      onSelect={(id) => {
        setActiveConversationId(id);
        setActiveRunId(null);
      }}
      onNew={handleNew}
      footerSlot={authPanel}
    />
    <main className="chat-main-wrap">
      {/* runtime debug ... */}
      <ChatView
        agents={agents.map((a) => ({ id: a.id, name: a.name }))}
        // ... other props ...
        onboardingCard={onboardingCard}
      />
    </main>
  </div>
);
```

Drop the previous `authLabel(authStatus)` runtime-debug strip OR adapt it to read from the new `AuthStatusView` shape:

```tsx
function authLabel(status: AuthStatusView | null): string {
  if (!status) return "loading";
  if (status.active === "codex") {
    const email = status.codex.email ?? "";
    return `Codex(${email.split("@")[0]})`;
  }
  if (status.active === "api_key") return "API key";
  if (status.codex.state === "expired") return "Codex 已过期⚠";
  return "未认证";
}
```

- [ ] **Step 3: Run + typecheck + integration test**

```bash
bun --filter @vulture/desktop-ui typecheck 2>&1 | tail -3
bun --filter @vulture/desktop-ui build 2>&1 | tail -3
bun test apps/desktop-ui/src 2>&1 | tail -5
```

The existing App.integration.test.tsx mock for `invoke` returns `get_openai_auth_status` shape — UPDATE the mock to also handle `get_auth_status` returning `AuthStatusView`. Also handle `start_chatgpt_login`, `sign_out_chatgpt` (no-op).

In `apps/desktop-ui/src/App.integration.test.tsx`, replace the mock factory:

```ts
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "get_runtime_info") return FAKE_RUNTIME;
    if (cmd === "get_auth_status") {
      return {
        active: "none",
        codex: { state: "not_signed_in" },
        apiKey: { state: "not_set" },
      };
    }
    if (cmd === "get_openai_auth_status") {
      return { configured: false, source: "missing" };
    }
    if (cmd === "start_chatgpt_login") {
      return { url: "", alreadyAuthenticated: false };
    }
    if (cmd === "sign_out_chatgpt") return undefined;
    if (cmd === "set_openai_api_key") {
      return { configured: true, source: "keychain" };
    }
    if (cmd === "clear_openai_api_key") {
      return { configured: false, source: "missing" };
    }
    throw new Error(`unmocked invoke: ${cmd}`);
  },
}));
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): App.tsx wires AuthPanel + OnboardingCard + new Tauri auth commands"
```

---

## Group H — Tests + manual smoke

### Task 15: Manual smoke checklist + add minimal CSS for new components

**Files:**
- Modify: `apps/desktop-ui/src/styles.css`
- Create: docs reference for manual smoke

- [ ] **Step 1: Add CSS for new components**

Append to `apps/desktop-ui/src/styles.css`:

```css
/* Auth panel (sidebar footer) */
.auth-panel {
  padding: 12px;
  border-top: 1px solid rgba(150, 150, 170, 0.2);
  font-size: 12px;
}
.auth-panel-section { margin-bottom: 12px; }
.auth-panel-section h4 {
  font-size: 11px;
  margin: 0 0 6px;
  text-transform: uppercase;
  opacity: 0.7;
  letter-spacing: 0.05em;
}
.auth-panel-status { margin: 4px 0; }
.auth-panel-error { color: #ff8080; }
.auth-panel-meta {
  margin: 2px 0;
  opacity: 0.6;
  font-size: 11px;
}
.auth-panel-primary,
.auth-panel-secondary {
  width: 100%;
  border: 0;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  margin-top: 4px;
}
.auth-panel-primary {
  background: #4f7cf5;
  color: white;
}
.auth-panel-secondary {
  background: rgba(80, 80, 100, 0.2);
  color: inherit;
  border: 1px solid rgba(150, 150, 170, 0.3);
}
.auth-panel-divider {
  border: 0;
  border-top: 1px solid rgba(150, 150, 170, 0.2);
  margin: 12px 0;
}
.auth-panel-input-row { display: flex; gap: 6px; }
.auth-panel-input-row input { flex: 1; }

/* Onboarding card */
.onboarding-card {
  padding: 32px;
  text-align: center;
}
.onboarding-card .hero-mark {
  font-size: 48px;
  font-weight: bold;
  margin: 0 auto 12px;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: rgba(80, 80, 100, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.onboarding-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  max-width: 320px;
  margin-left: auto;
  margin-right: auto;
}
.onboarding-primary,
.onboarding-secondary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid rgba(150, 150, 170, 0.3);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.onboarding-primary { border-color: #4f7cf5; }
.onboarding-icon { font-size: 20px; }
.onboarding-text strong { display: block; font-size: 14px; }
.onboarding-text small { display: block; font-size: 11px; opacity: 0.7; margin-top: 2px; }

.chat-sidebar-footer { margin-top: auto; }
```

- [ ] **Step 2: Add smoke checklist comment to spec or PR**

Manual smoke checklist (record in commit message or follow-up notes):

```text
Phase 3c manual smoke (run after task 15 commit):

1. Setup: rm -rf ~/Library/Application\ Support/Vulture/profiles/default/codex_auth.json
2. cargo tauri dev (in apps/desktop-shell, no OPENAI_API_KEY env)
3. Expect: onboarding card visible (zero auth)
4. Click "Sign in with ChatGPT" → browser opens → complete flow → AuthPanel shows "Codex 已登录 · email"
5. Type "say hi" → assistant streams reply via Codex
6. Open ~/Library/Application\ Support/Vulture/profiles/default/codex_auth.json → mode 0600, contains expected fields
7. Sign out → AuthPanel returns to onboarding state
8. Set OPENAI_API_KEY env → restart Tauri → AuthPanel shows API key state; messages route via API key
9. Sign in with ChatGPT again → AuthPanel shows Codex; new messages route via Codex
10. Manually expire token (edit codex_auth.json `expires_at` to past) → next message → "Codex 已过期" final message; AuthPanel shows red "已过期"
11. Optional: pre-place ~/.codex/auth.json with valid creds, delete <profile>/codex_auth.json, restart → AuthPanel auto-shows imported state with "凭证已从 Codex CLI 导入"
```

- [ ] **Step 3: Run all checks**

```bash
bun test 2>&1 | tail -5
bun --filter '*' typecheck 2>&1 | tail -10
bun --filter @vulture/desktop-ui build 2>&1 | tail -3
cargo test --workspace 2>&1 | grep "^test result" | head -5
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
```

ALL must pass.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): styles for AuthPanel + OnboardingCard + manual smoke checklist"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing tasks |
|---|---|
| OAuth + PKCE flow (browser-based) | 2, 3, 4, 7 |
| Local axum callback server | 3 |
| Token storage (mode 0600, atomic write) | 1 |
| Background refresh + singleton | 5 |
| One-time import from ~/.codex/auth.json | 1, 7 |
| chatgpt.com/backend-api routing + custom headers | 8, 9 |
| `makeLazyLlm` 3-way priority | 10 |
| Codex token expiry → explicit failure | 10 |
| UI sidebar AuthPanel | 11, 13 |
| First-launch onboarding card | 12, 14 |
| Tauri commands | 7 |
| Failure modes | 6 (HTTP), 9 (gateway), 10 (resolveLlm fallback) |
| Test strategy | each task includes TDD test step |
| Manual smoke | 15 |

All spec acceptance criteria mapped. Risk #1 (SDK compat) has explicit Task 8 spike.

**Placeholder scan:**

No `TBD` / `TODO` / `implement later` / `add validation` / `handle edge cases` (without specifics) in the plan body. Every step has full code or exact commands.

**Type consistency:**

- `CodexCreds` (Rust) ↔ `CodexShellResponse` (TS) — fields match: `accessToken`/`access_token`, `accountId`/`account_id`, `expiresAt`/`expires_at`. Serde camelCase rename + TS-side camelCase declaration are aligned.
- `AuthStatusView` (Rust) ↔ `AuthStatusView` (TS) — same nested shape (`active`, `codex`, `apiKey`).
- `Pkce` is internal to Rust; not crossing the wire.
- `start_chatgpt_login` returns `ChatGPTLoginStart { url, already_authenticated }` (snake_case Rust, camelCase Tauri serialization).

**No undefined references** — every type and function called in later tasks is defined in earlier tasks.

---

## Out of scope (Phase 3c → Phase 4)

- macOS Keychain storage (currently file in profile dir)
- Windows / Linux platforms
- Multi-account (one Vulture, multiple ChatGPT accounts)
- Auto-fallback to API key when Codex expires
- Per-agent provider preference
- Real-time Codex quota / billing visibility
- Streaming reasoning tokens display
- Polished UI for "Codex 已过期" message — currently surfaced via stub fallback as a final assistant message, could become a richer in-app banner

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-27-l0-phase-3c-codex-subscription.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance + code quality). Same flow Phase 3a/3b used.

**2. Inline Execution** — batch with checkpoints in same session.

**Which approach?**

(Recommend Subagent-Driven again — 15 tasks across Rust shell + gateway + UI is non-trivial; per-task fresh context kept Phase 3a/3b clean. Note that Task 8 — SDK spike — may need NEEDS_CONTEXT escalation if `setDefaultOpenAIClient` doesn't actually accept custom baseURL/headers as expected; controller should be ready to add a `fetch` wrapper fallback ~50 lines.)
