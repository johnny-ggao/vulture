use std::net::SocketAddr;

use anyhow::{Context, Result};
use axum::{routing::get, Json, Router};
use serde::Serialize;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    role: &'static str,
}

pub fn router() -> Router {
    Router::new().route(
        "/healthz",
        get(|| async {
            Json(HealthResponse {
                ok: true,
                role: "shell-callback",
            })
        }),
    )
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

pub async fn serve(port: u16) -> Result<ToolCallbackHandle> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    let bound_port = listener.local_addr()?.port();

    let (tx, rx) = oneshot::channel::<()>();
    let app = router();
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

    #[tokio::test]
    async fn healthz_returns_ok() {
        let handle = serve(0).await.expect("serve should bind");
        let port = handle.bound_port;
        let body: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["role"], "shell-callback");
        handle.shutdown().await;
    }
}
