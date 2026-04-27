use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use axum::{extract::Query, http::StatusCode, response::Html, routing::get, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures::future::{BoxFuture, Shared};
use futures::FutureExt;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, sync::oneshot, sync::Mutex as AsyncMutex, task::JoinHandle};

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
///
/// SECURITY: Does NOT verify the JWT signature. Acceptable here because the
/// id_token is received over TLS directly from OpenAI's token endpoint
/// (trusted-by-protocol). Do NOT use this helper for tokens from untrusted
/// sources.
fn expires_at_from_jwt(jwt: &str) -> Option<u64> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    let exp = value.get("exp")?.as_u64()?;
    Some(exp * 1000)  // exp is seconds, we use ms
}

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

#[derive(Debug, Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    #[allow(dead_code)]
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

async fn post_token_form(
    token_url: &str,
    form: &[(&str, &str)],
    label: &'static str,
) -> Result<TokenResponse> {
    let response = reqwest::Client::new()
        .post(token_url)
        .form(form)
        .send()
        .await
        .with_context(|| format!("POST {token_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("{label} endpoint returned {status}: {body}"));
    }
    response.json().await.with_context(|| format!("parse {label} response"))
}

/// POST to token_url with `grant_type=authorization_code` form body.
pub async fn exchange_authorization_code(
    token_url: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse> {
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("code_verifier", code_verifier),
        ("redirect_uri", redirect_uri),
    ];
    post_token_form(token_url, &form, "token").await
}

/// POST refresh request. Same shape as exchange_authorization_code response.
pub async fn refresh_access_token(
    token_url: &str,
    refresh_token: &str,
) -> Result<TokenResponse> {
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
    ];
    post_token_form(token_url, &form, "refresh").await
}

/// In-flight refresh future. `String` (not `anyhow::Error`) because `Shared`
/// requires `Clone`-able output and `anyhow::Error` carries a non-Clone
/// context chain.
type SharedRefreshFuture = Shared<BoxFuture<'static, std::result::Result<TokenResponse, String>>>;

/// Concurrency-safe refresh primitive: when multiple callers request a
/// refresh at the same time, only ONE actual HTTP request to OpenAI's token
/// endpoint fires. Other callers wait on the same in-flight `Shared` future.
#[derive(Default, Clone)]
pub struct RefreshSingleton {
    inflight: Arc<AsyncMutex<Option<SharedRefreshFuture>>>,
}

impl RefreshSingleton {
    /// If a refresh is already in flight, wait for it. Otherwise, start one.
    pub async fn refresh_once(
        &self,
        token_url: &str,
        refresh_token: &str,
    ) -> Result<TokenResponse> {
        let mut guard = self.inflight.lock().await;
        if let Some(shared) = &*guard {
            let fut = shared.clone();
            drop(guard);
            return fut.await.map_err(|e| anyhow!("refresh failed: {e}"));
        }
        let token_url = token_url.to_string();
        let refresh_token = refresh_token.to_string();
        let fut: BoxFuture<'static, std::result::Result<TokenResponse, String>> =
            Box::pin(async move {
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

/// Extract `chatgpt_account_id` and `email` claims from the id_token JWT.
///
/// SECURITY: Does NOT verify the JWT signature. Acceptable here because the
/// id_token is received over TLS directly from OpenAI's token endpoint
/// (trusted-by-protocol). Do NOT use this helper for tokens from untrusted
/// sources.
fn decode_account_from_id_token(id_token: &str) -> Result<(String, Option<String>)> {
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

    #[tokio::test]
    async fn exchange_code_constructs_correct_request() {
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

    #[tokio::test]
    async fn refresh_singleton_fires_only_one_http_request_under_concurrency() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use axum::{routing::post, Router, response::Json};

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
}
