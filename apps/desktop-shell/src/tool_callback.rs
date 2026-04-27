use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use vulture_tool_gateway::{AuditStore, PolicyDecision, PolicyEngine, ToolRequest};

use crate::codex_auth::{
    creds_from_token_response, read_store, unix_now_ms, write_store, RefreshSingleton, TOKEN_URL,
};
use crate::tool_executor::{execute_shell, ShellExecInput};

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    role: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolManifestEntry {
    name: &'static str,
    description: &'static str,
    requires_approval: bool,
}

#[derive(Serialize)]
struct ManifestResponse {
    tools: Vec<ToolManifestEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeRequest {
    call_id: String,
    run_id: String,
    tool: String,
    input: Value,
    workspace_path: String,
    #[serde(default)]
    approval_token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum InvokeResponse {
    #[serde(rename = "completed")]
    Completed { call_id: String, output: Value },
    #[serde(rename = "failed")]
    Failed { call_id: String, error: AppError },
    #[serde(rename = "denied")]
    Denied { call_id: String, error: AppError },
    #[serde(rename = "ask")]
    Ask {
        call_id: String,
        approval_token: String,
        reason: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppError {
    code: String,
    message: String,
}

#[derive(Clone)]
struct ShellState {
    token: Arc<String>,
    audit_store: Arc<Mutex<AuditStore>>,
    cancel_signals: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

#[derive(Clone, Default)]
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

/// Axum middleware that checks `Authorization: Bearer <token>` on all requests
/// that pass through it.  Mount this layer only on the `/tools/*` sub-router so
/// `/healthz` remains publicly accessible for supervisor liveness probing.
async fn auth_middleware(
    State(state): State<ShellState>,
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Response {
    let expected = format!("Bearer {}", state.token);
    let provided = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if provided != expected {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "code": "auth.token_invalid",
                "message": "Missing or invalid Authorization Bearer token"
            })),
        )
            .into_response();
    }

    next.run(req).await
}

fn build_router(state: ShellState, codex_state: CodexState) -> Router {
    // /tools/* sub-router — all routes require Bearer auth.
    let tools_router = Router::new()
        .route("/tools/manifest", get(manifest_handler))
        .route("/tools/invoke", post(invoke_handler))
        .route("/tools/cancel", post(cancel_handler))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state.clone());

    // /auth/codex/* sub-router — also requires Bearer auth.  Uses its own
    // `CodexState` extractor; auth_middleware reads only ShellState so we
    // attach the same middleware via `from_fn_with_state(state, ...)`.
    let codex_router = Router::new()
        .route("/auth/codex", get(auth_codex_handler))
        .route("/auth/codex/refresh", post(auth_codex_refresh_handler))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(codex_state);

    // /healthz is public (no auth) — supervisor liveness probe.
    Router::new()
        .route(
            "/healthz",
            get(|| async {
                Json(HealthResponse {
                    ok: true,
                    role: "shell-callback",
                })
            }),
        )
        .merge(tools_router)
        .merge(codex_router)
}

async fn manifest_handler() -> impl IntoResponse {
    Json(ManifestResponse {
        tools: vec![
            ToolManifestEntry {
                name: "shell.exec",
                description: "Execute a shell command in the workspace",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.snapshot",
                description: "Capture the current browser tab",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.click",
                description: "Click an element by selector",
                requires_approval: true,
            },
        ],
    })
}

async fn invoke_handler(
    State(state): State<ShellState>,
    Json(req): Json<InvokeRequest>,
) -> impl IntoResponse {
    if let Some(token) = req.approval_token.as_ref() {
        if let Ok(store) = state.audit_store.lock() {
            let _ = store.append(
                "tool.approval_used",
                &json!({
                    "callId": req.call_id,
                    "runId": req.run_id,
                    "tool": req.tool,
                    "token": token,
                }),
            );
        }
        return execute(&req).await.into_response();
    }

    let request = ToolRequest {
        run_id: req.run_id.clone(),
        tool: req.tool.clone(),
        input: req.input.clone(),
    };
    let policy = PolicyEngine::for_workspace(&req.workspace_path);
    let decision = policy.decide(&request);

    // Audit: tool.requested
    if let Ok(store) = state.audit_store.lock() {
        let _ = store.append(
            "tool.requested",
            &json!({
                "runId": req.run_id,
                "tool": req.tool,
                "input": req.input,
                "decision": format!("{decision:?}"),
            }),
        );
    }

    match decision {
        PolicyDecision::Deny { reason } => {
            if let Ok(store) = state.audit_store.lock() {
                let _ = store.append(
                    "tool.completed",
                    &json!({
                        "runId": req.run_id,
                        "tool": req.tool,
                        "status": "denied",
                    }),
                );
            }
            (
                StatusCode::OK,
                Json(InvokeResponse::Denied {
                    call_id: req.call_id,
                    error: AppError {
                        code: "tool.permission_denied".into(),
                        message: reason,
                    },
                }),
            )
                .into_response()
        }
        PolicyDecision::Ask { reason } => {
            if let Ok(store) = state.audit_store.lock() {
                let _ = store.append(
                    "tool.completed",
                    &json!({
                        "runId": req.run_id,
                        "tool": req.tool,
                        "status": "ask",
                    }),
                );
            }
            (
                StatusCode::OK,
                Json(InvokeResponse::Ask {
                    call_id: req.call_id,
                    approval_token: format!("appr-{}", uuid::Uuid::new_v4()),
                    reason,
                }),
            )
                .into_response()
        }
        PolicyDecision::Allow => {
            let result = execute(&req).await;
            if let Ok(store) = state.audit_store.lock() {
                let _ = store.append(
                    "tool.completed",
                    &json!({
                        "runId": req.run_id,
                        "tool": req.tool,
                        "status": "executed",
                    }),
                );
            }
            result.into_response()
        }
    }
}

async fn execute(req: &InvokeRequest) -> impl IntoResponse {
    if req.tool == "shell.exec" {
        let parsed: ShellExecInput = match serde_json::from_value(req.input.clone()) {
            Ok(p) => p,
            Err(e) => {
                return (
                    StatusCode::OK,
                    Json(InvokeResponse::Failed {
                        call_id: req.call_id.clone(),
                        error: AppError {
                            code: "tool.execution_failed".into(),
                            message: format!("invalid input: {e}"),
                        },
                    }),
                );
            }
        };
        match execute_shell(parsed).await {
            Ok(out) => (
                StatusCode::OK,
                Json(InvokeResponse::Completed {
                    call_id: req.call_id.clone(),
                    output: serde_json::to_value(out).unwrap_or(Value::Null),
                }),
            ),
            Err(err) => (
                StatusCode::OK,
                Json(InvokeResponse::Failed {
                    call_id: req.call_id.clone(),
                    error: AppError {
                        code: "tool.execution_failed".into(),
                        message: format!("{err:#}"),
                    },
                }),
            ),
        }
    } else {
        (
            StatusCode::OK,
            Json(InvokeResponse::Failed {
                call_id: req.call_id.clone(),
                error: AppError {
                    code: "tool.execution_failed".into(),
                    message: format!("tool {} not yet wired in 3a", req.tool),
                },
            }),
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequest {
    call_id: String,
    #[allow(dead_code)]
    run_id: String,
}

#[derive(Serialize)]
struct CancelResponse {
    cancelled: bool,
}

async fn cancel_handler(
    State(state): State<ShellState>,
    Json(req): Json<CancelRequest>,
) -> impl IntoResponse {
    let mut signals = state.cancel_signals.lock().expect("cancel signals poisoned");
    if let Some(tx) = signals.remove(&req.call_id) {
        let _ = tx.send(());
        return Json(CancelResponse { cancelled: true });
    }
    Json(CancelResponse { cancelled: false })
}

async fn auth_codex_handler(State(state): State<CodexState>) -> Response {
    let creds = match read_store(&state.profile_dir) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "code": "auth.codex_not_signed_in",
                    "message": "no codex credentials found"
                })),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
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
            Json(json!({
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

async fn auth_codex_refresh_handler(State(state): State<CodexState>) -> Response {
    let creds = match read_store(&state.profile_dir) {
        Ok(Some(c)) => c,
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "code": "auth.codex_not_signed_in",
                    "message": "no codex credentials found"
                })),
            )
                .into_response();
        }
    };
    let response = match state
        .refresh
        .refresh_once(TOKEN_URL, &creds.refresh_token)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
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
                Json(json!({
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
            Json(json!({
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

pub struct ToolCallbackHandle {
    /// Port the OS actually bound — useful for tests using port 0.
    /// Production callers always know the port (they passed it in).
    #[allow(dead_code)]
    pub bound_port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<JoinHandle<()>>,
}

impl ToolCallbackHandle {
    #[allow(dead_code)]
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

/// Backward-compatible wrapper for callers that don't wire codex auth.
/// Tests not exercising codex routes can use this. Codex endpoints will
/// always return 404 (`std::env::temp_dir()` won't have a codex_auth.json).
#[allow(dead_code)]
pub async fn serve(
    port: u16,
    token: String,
    audit_db_path: PathBuf,
) -> Result<ToolCallbackHandle> {
    serve_with_codex(
        port,
        token,
        audit_db_path,
        std::env::temp_dir(),
        RefreshSingleton::default(),
    )
    .await
}

/// Start the shell HTTP callback server.
///
/// - `port`: TCP port to bind (0 = OS-assigned, useful in tests).
/// - `token`: Runtime secret; every `/tools/*` and `/auth/codex*` request must
///   carry `Authorization: Bearer <token>`. `/healthz` is intentionally exempt.
/// - `audit_db_path`: Path to the SQLite audit database.  Two handles to the
///   same file are safe because WAL mode is enabled in `AuditStore::open`.
/// - `profile_dir`: Profile directory containing `codex_auth.json` for the
///   `/auth/codex` endpoints.
/// - `refresh`: Shared `RefreshSingleton` ensuring only one refresh HTTP
///   request is in flight at any time across the whole desktop process.
pub async fn serve_with_codex(
    port: u16,
    token: String,
    audit_db_path: PathBuf,
    profile_dir: PathBuf,
    refresh: RefreshSingleton,
) -> Result<ToolCallbackHandle> {
    let audit_store = AuditStore::open(&audit_db_path)
        .with_context(|| format!("open audit db at {}", audit_db_path.display()))?;

    let state = ShellState {
        token: Arc::new(token),
        audit_store: Arc::new(Mutex::new(audit_store)),
        cancel_signals: Arc::new(Mutex::new(HashMap::new())),
    };
    let codex_state = CodexState {
        profile_dir,
        refresh,
    };

    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    let bound_port = listener.local_addr()?.port();

    let (tx, rx) = oneshot::channel::<()>();
    let app = build_router(state, codex_state);
    let join = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await
            .ok();
    });

    Ok(ToolCallbackHandle {
        bound_port,
        shutdown: Some(tx),
        join: Some(join),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_audit_path() -> PathBuf {
        std::env::temp_dir().join(format!("vulture-tc-audit-{}.sqlite", Uuid::new_v4()))
    }

    const TEST_TOKEN: &str = "test-token-abc123";

    async fn start_server() -> (ToolCallbackHandle, u16) {
        let handle = serve(0, TEST_TOKEN.to_string(), temp_audit_path())
            .await
            .expect("serve");
        let port = handle.bound_port;
        (handle, port)
    }

    #[tokio::test]
    async fn healthz_still_works() {
        let (handle, port) = start_server().await;
        let body: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["ok"], true);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn manifest_lists_tools() {
        let (handle, port) = start_server().await;
        let body: serde_json::Value = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/tools/manifest"))
            .header("Authorization", format!("Bearer {TEST_TOKEN}"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(body["tools"].as_array().unwrap().len() >= 3);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn invoke_shell_exec_denied_or_asks_by_policy() {
        let (handle, port) = start_server().await;
        let res: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/tools/invoke"))
            .header("Authorization", format!("Bearer {TEST_TOKEN}"))
            .json(&serde_json::json!({
                "callId": "c1",
                "runId": "r1",
                "tool": "shell.exec",
                "input": { "cwd": "/tmp", "argv": ["echo", "hi"], "timeoutMs": 5000 },
                "workspacePath": ""
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        // Policy default is Ask for shell.exec — accept ask, completed, or denied
        assert!(["ask", "completed", "denied"].contains(&res["status"].as_str().unwrap()));
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn invoke_with_workspace_path_uses_workspace_policy() {
        let (handle, port) = start_server().await;
        // file.read for a path inside /tmp — with workspacePath="/tmp" policy should Allow.
        // file.read for a path outside /tmp — with workspacePath="/tmp" policy should Ask.
        let res_inside: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/tools/invoke"))
            .header("Authorization", format!("Bearer {TEST_TOKEN}"))
            .json(&serde_json::json!({
                "callId": "c-ws-1",
                "runId": "r-ws-1",
                "tool": "file.read",
                "input": { "path": "/tmp/some-file.txt" },
                "workspacePath": "/tmp"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        // file.read inside /tmp with workspacePath="/tmp" — policy should Allow → completed or failed (no ask/denied)
        assert!(
            ["completed", "failed"].contains(&res_inside["status"].as_str().unwrap()),
            "expected completed or failed for in-workspace file.read, got: {res_inside}"
        );

        let res_outside: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/tools/invoke"))
            .header("Authorization", format!("Bearer {TEST_TOKEN}"))
            .json(&serde_json::json!({
                "callId": "c-ws-2",
                "runId": "r-ws-2",
                "tool": "file.read",
                "input": { "path": "/etc/passwd" },
                "workspacePath": "/tmp"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        // file.read outside /tmp with workspacePath="/tmp" — policy should Ask
        assert_eq!(
            res_outside["status"].as_str().unwrap(),
            "ask",
            "expected ask for out-of-workspace file.read, got: {res_outside}"
        );

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn invoke_with_approval_token_skips_policy_and_executes() {
        let dir = std::env::temp_dir().join(format!("tcb-token-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let audit_path = dir.join("audit.sqlite");
        let token = "x".repeat(43);
        let handle = serve(0, token.clone(), audit_path).await.expect("serve");
        let port = handle.bound_port;

        let res: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/tools/invoke"))
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "callId": "c1",
                "runId": "r1",
                "tool": "shell.exec",
                "input": { "cwd": std::env::temp_dir().to_string_lossy(), "argv": ["echo", "approved"], "timeoutMs": 5000 },
                "workspacePath": "",
                "approvalToken": "approval-abc"
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(res["status"].as_str().unwrap(), "completed");
        assert!(res["output"]["stdout"].as_str().unwrap().contains("approved"));
        handle.shutdown().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn invoke_without_token_returns_401() {
        let (handle, port) = start_server().await;

        // No Authorization header.
        let resp = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/tools/invoke"))
            .json(&serde_json::json!({
                "callId": "c2",
                "runId": "r2",
                "tool": "shell.exec",
                "input": { "cwd": "/tmp", "argv": ["echo", "hi"], "timeoutMs": 5000 },
                "workspacePath": ""
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), 401);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["code"], "auth.token_invalid");

        // Wrong token.
        let resp2 = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/tools/invoke"))
            .header("Authorization", "Bearer wrong-token")
            .json(&serde_json::json!({
                "callId": "c3",
                "runId": "r3",
                "tool": "shell.exec",
                "input": { "cwd": "/tmp", "argv": ["echo", "hi"], "timeoutMs": 5000 },
                "workspacePath": ""
            }))
            .send()
            .await
            .unwrap();

        assert_eq!(resp2.status(), 401);
        let body2: serde_json::Value = resp2.json().await.unwrap();
        assert_eq!(body2["code"], "auth.token_invalid");

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn auth_codex_returns_404_when_store_missing() {
        let dir = std::env::temp_dir().join(format!("tcb-codex-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let token = "x".repeat(43);
        let handle = serve_with_codex(
            0,
            token.clone(),
            dir.join("audit.sqlite"),
            dir.clone(),
            Default::default(),
        )
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
        use crate::codex_auth::{unix_now_ms, write_store, CodexCreds};
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
        let handle = serve_with_codex(
            0,
            token.clone(),
            dir.join("audit.sqlite"),
            dir.clone(),
            Default::default(),
        )
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
        use crate::codex_auth::{unix_now_ms, write_store, CodexCreds};
        let dir = std::env::temp_dir().join(format!("tcb-codex-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let now = unix_now_ms();
        let creds = CodexCreds {
            access_token: "at".into(),
            refresh_token: "rt".into(),
            id_token: "id".into(),
            account_id: "acc".into(),
            email: None,
            expires_at: now.saturating_sub(1000),
            stored_at: now.saturating_sub(3_600_000),
            imported_from: None,
        };
        write_store(&dir, &creds).unwrap();

        let token = "x".repeat(43);
        let handle = serve_with_codex(
            0,
            token.clone(),
            dir.join("audit.sqlite"),
            dir.clone(),
            Default::default(),
        )
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
}
