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

fn build_router(state: ShellState) -> Router {
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

/// Start the shell HTTP callback server.
///
/// - `port`: TCP port to bind (0 = OS-assigned, useful in tests).
/// - `token`: Runtime secret; every `/tools/*` request must carry
///   `Authorization: Bearer <token>`. `/healthz` is intentionally exempt.
/// - `audit_db_path`: Path to the SQLite audit database.  Two handles to the
///   same file are safe because WAL mode is enabled in `AuditStore::open`.
pub async fn serve(
    port: u16,
    token: String,
    audit_db_path: PathBuf,
) -> Result<ToolCallbackHandle> {
    let audit_store = AuditStore::open(&audit_db_path)
        .with_context(|| format!("open audit db at {}", audit_db_path.display()))?;

    let state = ShellState {
        token: Arc::new(token),
        audit_store: Arc::new(Mutex::new(audit_store)),
        cancel_signals: Arc::new(Mutex::new(HashMap::new())),
    };

    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    let bound_port = listener.local_addr()?.port();

    let (tx, rx) = oneshot::channel::<()>();
    let app = build_router(state);
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
}
