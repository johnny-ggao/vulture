use std::path::PathBuf;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::json;

use crate::codex_auth::{
    creds_from_token_response, read_store, unix_now_ms, write_store, RefreshSingleton, TOKEN_URL,
};

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

fn err_response(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "code": code, "message": message.into() })),
    )
        .into_response()
}

pub async fn auth_codex_handler(State(state): State<CodexState>) -> Response {
    let creds = match read_store(&state.profile_dir) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return err_response(
                StatusCode::NOT_FOUND,
                "auth.codex_not_signed_in",
                "no codex credentials found",
            );
        }
        Err(e) => {
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                format!("read store: {e:#}"),
            );
        }
    };
    if creds.expires_at <= unix_now_ms() {
        return err_response(
            StatusCode::UNAUTHORIZED,
            "auth.codex_expired",
            "codex token expired; refresh required",
        );
    }
    Json(CodexAuthResponse {
        access_token: creds.access_token,
        account_id: creds.account_id,
        expires_at: creds.expires_at,
        email: creds.email,
    })
    .into_response()
}

pub async fn auth_codex_refresh_handler(State(state): State<CodexState>) -> Response {
    let creds = match read_store(&state.profile_dir) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return err_response(
                StatusCode::NOT_FOUND,
                "auth.codex_not_signed_in",
                "no codex credentials found",
            );
        }
        Err(e) => {
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                format!("read store: {e:#}"),
            );
        }
    };
    let response = match state
        .refresh
        .refresh_once(TOKEN_URL, &creds.refresh_token)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return err_response(
                StatusCode::UNAUTHORIZED,
                "auth.codex_expired",
                format!("refresh failed: {e:#}"),
            );
        }
    };
    let new_creds = match creds_from_token_response(response, creds.imported_from.clone()) {
        Ok(c) => c,
        Err(e) => {
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                format!("creds from token: {e:#}"),
            );
        }
    };
    if let Err(e) = write_store(&state.profile_dir, &new_creds) {
        return err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("write store: {e:#}"),
        );
    }
    Json(CodexAuthResponse {
        access_token: new_creds.access_token,
        account_id: new_creds.account_id,
        expires_at: new_creds.expires_at,
        email: new_creds.email,
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use crate::tool_callback::serve_with_codex;

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
