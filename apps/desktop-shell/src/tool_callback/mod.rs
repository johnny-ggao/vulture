mod codex_routes;
mod model_auth_routes;

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
};

use anyhow::{Context, Result};
use axum::{
    body::Body,
    extract::{Query, Request, State},
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

use crate::auth::{KeychainSecretStore, SecretStore};
use crate::browser::{
    protocol::{BrowserRelayMessage, BrowserTab},
    relay::{BrowserActionResult, BrowserRelayState},
};
use crate::codex_auth::RefreshSingleton;
use crate::tool_executor::{execute_shell, ShellExecInput};
use codex_routes::{auth_codex_handler, auth_codex_refresh_handler, CodexState};
use model_auth_routes::{auth_model_api_key_handler, auth_model_profiles_handler};

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
    audit_db_path: Arc<RwLock<PathBuf>>,
    cancel_signals: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    browser_relay: Arc<Mutex<BrowserRelayState>>,
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
        .route("/auth/model-profiles", get(auth_model_profiles_handler))
        .route(
            "/auth/model-api-key/:profile_id",
            get(auth_model_api_key_handler),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(codex_state);

    let browser_router = Router::new()
        .route("/browser/hello", post(browser_hello_handler))
        .route("/browser/tabs", post(browser_tabs_handler))
        .route("/browser/requests", get(browser_requests_handler))
        .route("/browser/results", post(browser_results_handler))
        .with_state(state.clone());

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
        .merge(browser_router)
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
            ToolManifestEntry {
                name: "browser.input",
                description: "Set text into an element by selector",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.scroll",
                description: "Scroll the active browser page or selected element",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.extract",
                description: "Extract visible text and links from the active browser tab",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.navigate",
                description: "Navigate the active browser tab to a URL",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.wait",
                description: "Wait for page load, a selector, or a short delay",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.screenshot",
                description: "Capture a PNG screenshot of the active browser tab",
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
        append_audit(
            &state,
            "tool.approval_used",
            &json!({
                "callId": req.call_id,
                "runId": req.run_id,
                "tool": req.tool,
                "token": token,
            }),
        );
        return execute(&state, &req).await.into_response();
    }

    let request = ToolRequest {
        run_id: req.run_id.clone(),
        tool: req.tool.clone(),
        input: req.input.clone(),
    };
    let policy = PolicyEngine::for_workspace(&req.workspace_path);
    let decision = policy.decide(&request);

    // Audit: tool.requested
    append_audit(
        &state,
        "tool.requested",
        &json!({
            "runId": req.run_id,
            "tool": req.tool,
            "input": req.input,
            "decision": format!("{decision:?}"),
        }),
    );

    match decision {
        PolicyDecision::Deny { reason } => {
            append_audit(
                &state,
                "tool.completed",
                &json!({
                    "runId": req.run_id,
                    "tool": req.tool,
                    "status": "denied",
                }),
            );
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
            append_audit(
                &state,
                "tool.completed",
                &json!({
                    "runId": req.run_id,
                    "tool": req.tool,
                    "status": "ask",
                }),
            );
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
            let result = execute(&state, &req).await;
            append_audit(
                &state,
                "tool.completed",
                &json!({
                    "runId": req.run_id,
                    "tool": req.tool,
                    "status": "executed",
                }),
            );
            result.into_response()
        }
    }
}

fn append_audit(state: &ShellState, event_type: &str, payload: &Value) {
    let Ok(path) = state.audit_db_path.read().map(|path| path.clone()) else {
        return;
    };
    if let Ok(store) = AuditStore::open(&path) {
        let _ = store.append(event_type, payload);
    }
}

async fn execute(state: &ShellState, req: &InvokeRequest) -> impl IntoResponse {
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
    } else if req.tool.starts_with("browser.") {
        let receiver = {
            let mut relay = state
                .browser_relay
                .lock()
                .expect("browser relay lock poisoned");
            match relay.enqueue_action(req.tool.clone(), req.input.clone()) {
                Ok((_request, receiver)) => receiver,
                Err(err) => {
                    return (
                        StatusCode::OK,
                        Json(InvokeResponse::Failed {
                            call_id: req.call_id.clone(),
                            error: AppError {
                                code: "tool.browser_not_paired".into(),
                                message: format!("{err:#}"),
                            },
                        }),
                    );
                }
            }
        };

        match tokio::time::timeout(std::time::Duration::from_secs(30), receiver).await {
            Ok(Ok(BrowserActionResult { ok: true, value })) => (
                StatusCode::OK,
                Json(InvokeResponse::Completed {
                    call_id: req.call_id.clone(),
                    output: value,
                }),
            ),
            Ok(Ok(BrowserActionResult { ok: false, value })) => (
                StatusCode::OK,
                Json(InvokeResponse::Failed {
                    call_id: req.call_id.clone(),
                    error: AppError {
                        code: "tool.execution_failed".into(),
                        message: value
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("browser action failed")
                            .to_string(),
                    },
                }),
            ),
            Ok(Err(_closed)) => (
                StatusCode::OK,
                Json(InvokeResponse::Failed {
                    call_id: req.call_id.clone(),
                    error: AppError {
                        code: "tool.execution_failed".into(),
                        message: "browser action was cancelled".into(),
                    },
                }),
            ),
            Err(_elapsed) => (
                StatusCode::OK,
                Json(InvokeResponse::Failed {
                    call_id: req.call_id.clone(),
                    error: AppError {
                        code: "tool.execution_failed".into(),
                        message: "browser action timed out".into(),
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

async fn browser_hello_handler(
    State(state): State<ShellState>,
    Json(message): Json<BrowserRelayMessage>,
) -> impl IntoResponse {
    let BrowserRelayMessage::ExtensionHello {
        pairing_token,
        extension_version,
        ..
    } = message
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "message": "expected Extension.hello" })),
        );
    };

    let ok = state
        .browser_relay
        .lock()
        .expect("browser relay lock poisoned")
        .accept_token_with_extension(&pairing_token, &extension_version);
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::UNAUTHORIZED
    };
    (status, Json(json!({ "ok": ok })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserTabsRequest {
    token: String,
    tabs: Vec<BrowserTab>,
}

async fn browser_tabs_handler(
    State(state): State<ShellState>,
    Json(req): Json<BrowserTabsRequest>,
) -> impl IntoResponse {
    let ok = state
        .browser_relay
        .lock()
        .expect("browser relay lock poisoned")
        .update_tabs_for_token(&req.token, req.tabs);
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::UNAUTHORIZED
    };
    (status, Json(json!({ "ok": ok })))
}

#[derive(Deserialize)]
struct BrowserRequestQuery {
    token: String,
}

async fn browser_requests_handler(
    State(state): State<ShellState>,
    Query(query): Query<BrowserRequestQuery>,
) -> impl IntoResponse {
    let action = state
        .browser_relay
        .lock()
        .expect("browser relay lock poisoned")
        .take_next_action(&query.token);

    match action {
        Ok(Some(action)) => (StatusCode::OK, Json(serde_json::to_value(action).unwrap())),
        Ok(None) => (StatusCode::NO_CONTENT, Json(Value::Null)),
        Err(err) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "code": "auth.token_invalid", "message": format!("{err:#}") })),
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserResultRequest {
    token: String,
    request_id: String,
    ok: bool,
    value: Value,
}

async fn browser_results_handler(
    State(state): State<ShellState>,
    Json(req): Json<BrowserResultRequest>,
) -> impl IntoResponse {
    let ok = state
        .browser_relay
        .lock()
        .expect("browser relay lock poisoned")
        .complete_action(&req.token, &req.request_id, req.ok, req.value);
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    (status, Json(json!({ "ok": ok })))
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
    let mut signals = state
        .cancel_signals
        .lock()
        .expect("cancel signals poisoned");
    if let Some(tx) = signals.remove(&req.call_id) {
        let _ = tx.send(());
        return Json(CancelResponse { cancelled: true });
    }
    Json(CancelResponse { cancelled: false })
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
pub async fn serve(port: u16, token: String, audit_db_path: PathBuf) -> Result<ToolCallbackHandle> {
    serve_with_codex_and_browser_relay(
        port,
        token,
        Arc::new(RwLock::new(audit_db_path)),
        Arc::new(RwLock::new(std::env::temp_dir())),
        Arc::new(KeychainSecretStore),
        RefreshSingleton::default(),
        Arc::new(Mutex::new(BrowserRelayState::default())),
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
#[allow(dead_code)]
pub async fn serve_with_codex(
    port: u16,
    token: String,
    audit_db_path: PathBuf,
    profile_dir: PathBuf,
    refresh: RefreshSingleton,
) -> Result<ToolCallbackHandle> {
    serve_with_codex_and_browser_relay(
        port,
        token,
        Arc::new(RwLock::new(audit_db_path)),
        Arc::new(RwLock::new(profile_dir)),
        Arc::new(KeychainSecretStore),
        refresh,
        Arc::new(Mutex::new(BrowserRelayState::default())),
    )
    .await
}

pub async fn serve_with_codex_and_browser_relay(
    port: u16,
    token: String,
    audit_db_path: Arc<RwLock<PathBuf>>,
    profile_dir: Arc<RwLock<PathBuf>>,
    secret_store: Arc<dyn SecretStore>,
    refresh: RefreshSingleton,
    browser_relay: Arc<Mutex<BrowserRelayState>>,
) -> Result<ToolCallbackHandle> {
    let state = ShellState {
        token: Arc::new(token),
        audit_db_path,
        cancel_signals: Arc::new(Mutex::new(HashMap::new())),
        browser_relay,
    };
    let codex_state = CodexState {
        profile_dir,
        secret_store,
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
    async fn invoke_shell_exec_asking_for_etc_hosts_returns_ask() {
        let dir = std::env::temp_dir().join(format!("tcb-workspace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (handle, port) = start_server().await;

        let res: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/tools/invoke"))
            .header("Authorization", format!("Bearer {TEST_TOKEN}"))
            .json(&serde_json::json!({
                "callId": "c-etc-hosts",
                "runId": "r-etc-hosts",
                "tool": "shell.exec",
                "input": { "cwd": dir.to_string_lossy(), "argv": ["cat", "/etc/hosts"], "timeoutMs": 5000 },
                "workspacePath": dir.to_string_lossy()
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(res["status"].as_str().unwrap(), "ask");
        assert_eq!(
            res["reason"].as_str().unwrap(),
            "shell.exec references path outside workspace"
        );

        handle.shutdown().await;
        std::fs::remove_dir_all(dir).ok();
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
        assert!(res["output"]["stdout"]
            .as_str()
            .unwrap()
            .contains("approved"));
        handle.shutdown().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn browser_snapshot_waits_for_extension_result() {
        let relay = Arc::new(Mutex::new(
            crate::browser::relay::BrowserRelayState::default(),
        ));
        let pairing_token = {
            let mut relay_state = relay.lock().expect("relay lock");
            relay_state
                .enable_pairing(9444)
                .expect("pairing should start")
                .pairing_token
                .expect("token should be present")
        };
        let dir = std::env::temp_dir().join(format!("tcb-browser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let audit_path = dir.join("audit.sqlite");
        let token = "x".repeat(43);
        let handle = serve_with_codex_and_browser_relay(
            0,
            token.clone(),
            Arc::new(RwLock::new(audit_path)),
            Arc::new(RwLock::new(std::env::temp_dir())),
            Arc::new(crate::auth::MemorySecretStore::default()),
            RefreshSingleton::default(),
            relay,
        )
        .await
        .expect("serve");
        let port = handle.bound_port;

        let hello: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/browser/hello"))
            .json(&serde_json::json!({
                "method": "Extension.hello",
                "params": {
                    "protocol_version": 1,
                    "extension_version": "0.1.0",
                    "pairing_token": pairing_token
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(hello["ok"], true);

        let invoke = tokio::spawn({
            let token = token.clone();
            async move {
                reqwest::Client::new()
                    .post(format!("http://127.0.0.1:{port}/tools/invoke"))
                    .header("Authorization", format!("Bearer {}", token))
                    .json(&serde_json::json!({
                        "callId": "c-browser",
                        "runId": "r-browser",
                        "tool": "browser.snapshot",
                        "input": {},
                        "workspacePath": "",
                        "approvalToken": "approval-browser"
                    }))
                    .send()
                    .await
                    .unwrap()
                    .json::<serde_json::Value>()
                    .await
                    .unwrap()
            }
        });

        let mut action = serde_json::Value::Null;
        for _ in 0..20 {
            let response = reqwest::Client::new()
                .get(format!(
                    "http://127.0.0.1:{port}/browser/requests?token={}",
                    pairing_token
                ))
                .send()
                .await
                .unwrap();
            if response.status() == reqwest::StatusCode::OK {
                action = response.json().await.unwrap();
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(action["tool"], "browser.snapshot");

        let result: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/browser/results"))
            .json(&serde_json::json!({
                "token": pairing_token,
                "requestId": action["requestId"],
                "ok": true,
                "value": { "title": "Example", "text": "Hello from browser" }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["ok"], true);

        let completed = invoke.await.expect("invoke task should complete");
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["output"]["title"], "Example");

        handle.shutdown().await;
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn browser_input_waits_for_extension_result() {
        let relay = Arc::new(Mutex::new(
            crate::browser::relay::BrowserRelayState::default(),
        ));
        let pairing_token = {
            let mut relay_state = relay.lock().expect("relay lock");
            relay_state
                .enable_pairing(9444)
                .expect("pairing should start")
                .pairing_token
                .expect("token should be present")
        };
        let dir = std::env::temp_dir().join(format!("tcb-browser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let audit_path = dir.join("audit.sqlite");
        let token = "x".repeat(43);
        let handle = serve_with_codex_and_browser_relay(
            0,
            token.clone(),
            Arc::new(RwLock::new(audit_path)),
            Arc::new(RwLock::new(std::env::temp_dir())),
            Arc::new(crate::auth::MemorySecretStore::default()),
            RefreshSingleton::default(),
            relay,
        )
        .await
        .expect("serve");
        let port = handle.bound_port;

        let hello: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/browser/hello"))
            .json(&serde_json::json!({
                "method": "Extension.hello",
                "params": {
                    "protocol_version": 1,
                    "extension_version": "0.1.0",
                    "pairing_token": pairing_token
                }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(hello["ok"], true);

        let invoke = tokio::spawn({
            let token = token.clone();
            async move {
                reqwest::Client::new()
                    .post(format!("http://127.0.0.1:{port}/tools/invoke"))
                    .header("Authorization", format!("Bearer {}", token))
                    .json(&serde_json::json!({
                        "callId": "c-browser-input",
                        "runId": "r-browser",
                        "tool": "browser.input",
                        "input": { "selector": "input[name=q]", "text": "hello", "submit": false },
                        "workspacePath": "",
                        "approvalToken": "approval-browser"
                    }))
                    .send()
                    .await
                    .unwrap()
                    .json::<serde_json::Value>()
                    .await
                    .unwrap()
            }
        });

        let mut action = serde_json::Value::Null;
        for _ in 0..20 {
            let response = reqwest::Client::new()
                .get(format!(
                    "http://127.0.0.1:{port}/browser/requests?token={}",
                    pairing_token
                ))
                .send()
                .await
                .unwrap();
            if response.status() == reqwest::StatusCode::OK {
                action = response.json().await.unwrap();
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(action["tool"], "browser.input");
        assert_eq!(action["input"]["text"], "hello");

        let result: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/browser/results"))
            .json(&serde_json::json!({
                "token": pairing_token,
                "requestId": action["requestId"],
                "ok": true,
                "value": { "input": true, "selector": "input[name=q]" }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["ok"], true);

        let completed = invoke.await.expect("invoke task should complete");
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["output"]["input"], true);

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
}
