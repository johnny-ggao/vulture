use axum::{extract::State, response::IntoResponse, Json};

use crate::{
    codex_auth::{read_store, unix_now_ms},
    model_auth::project_model_auth_profiles,
    tool_callback::codex_routes::CodexState,
};

pub async fn auth_model_profiles_handler(State(state): State<CodexState>) -> impl IntoResponse {
    let codex_creds = state
        .profile_dir
        .read()
        .ok()
        .and_then(|profile_dir| read_store(&profile_dir).ok().flatten());

    Json(project_model_auth_profiles(codex_creds, unix_now_ms()))
}

#[cfg(test)]
mod tests {
    use crate::{
        codex_auth::{unix_now_ms, write_store, CodexCreds},
        tool_callback::serve_with_codex,
    };

    #[tokio::test]
    async fn model_auth_route_returns_projected_codex_profile() {
        let dir = std::env::temp_dir().join(format!("tcb-model-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let now = unix_now_ms();
        write_store(
            &dir,
            &CodexCreds {
                access_token: "at".into(),
                refresh_token: "rt".into(),
                id_token: "id".into(),
                account_id: "acc".into(),
                email: Some("dev@example.com".into()),
                expires_at: now + 3_600_000,
                stored_at: now,
                imported_from: Some("~/.codex/auth.json".into()),
            },
        )
        .unwrap();

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
            .get(format!("http://127.0.0.1:{port}/auth/model-profiles"))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: serde_json::Value = res.json().await.unwrap();
        assert_eq!(body["profiles"][0]["id"], "codex");
        assert_eq!(body["profiles"][0]["provider"], "openai");
        assert_eq!(body["profiles"][0]["mode"], "oauth");
        assert_eq!(body["profiles"][0]["status"], "configured");
        assert_eq!(body["profiles"][0]["email"], "dev@example.com");
        assert_eq!(body["auth_order"]["openai"][0], "codex");

        handle.shutdown().await;
        std::fs::remove_dir_all(&dir).ok();
    }
}
