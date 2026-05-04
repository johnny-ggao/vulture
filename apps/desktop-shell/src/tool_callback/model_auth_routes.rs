use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::json;
use vulture_core::Profile;

use crate::{
    codex_auth::{read_store, unix_now_ms},
    model_auth::{project_model_auth_profiles, ModelAuthProfileView},
    state::model_api_key_secret_ref,
    tool_callback::codex_routes::CodexState,
};

pub async fn auth_model_profiles_handler(State(state): State<CodexState>) -> impl IntoResponse {
    let profile = current_profile(&state);
    let codex_creds = state
        .profile_dir
        .read()
        .ok()
        .and_then(|profile_dir| read_store(&profile_dir).ok().flatten());

    let mut response = project_model_auth_profiles(codex_creds, unix_now_ms());
    response
        .profiles
        .extend(configured_api_key_profiles(&state, profile.as_ref()));

    Json(response)
}

#[derive(Serialize)]
struct ModelApiKeyResponse {
    api_key: String,
}

pub async fn auth_model_api_key_handler(
    State(state): State<CodexState>,
    Path(profile_id): Path<String>,
) -> Response {
    let Some(profile) = current_profile(&state) else {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, "profile unavailable");
    };
    let Ok(secret_ref) =
        model_api_key_secret_ref(&profile.id.0, &profile.openai_secret_ref, &profile_id)
    else {
        return error_response(StatusCode::NOT_FOUND, "unsupported model API key profile");
    };
    match state.secret_store.get(&secret_ref) {
        Ok(Some(api_key)) if !api_key.trim().is_empty() => {
            Json(ModelApiKeyResponse { api_key }).into_response()
        }
        Ok(_) => error_response(StatusCode::NOT_FOUND, "model API key not configured"),
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("read model API key: {error:#}"),
        ),
    }
}

fn configured_api_key_profiles(
    state: &CodexState,
    profile: Option<&Profile>,
) -> Vec<ModelAuthProfileView> {
    let Some(profile) = profile else {
        return Vec::new();
    };
    [
        ("openai-api-key", "openai", "OpenAI API Key"),
        ("anthropic-api-key", "anthropic", "Anthropic API Key"),
        ("gemini-api-key", "google", "Gemini API Key"),
    ]
    .into_iter()
    .filter_map(|(id, provider, label)| {
        let secret_ref =
            model_api_key_secret_ref(&profile.id.0, &profile.openai_secret_ref, id).ok()?;
        match state.secret_store.get(&secret_ref) {
            Ok(Some(api_key)) if !api_key.trim().is_empty() => Some(ModelAuthProfileView {
                id: id.to_string(),
                provider: provider.to_string(),
                mode: "api_key".to_string(),
                label: label.to_string(),
                status: "configured".to_string(),
                email: None,
                expires_at: None,
                source: Some("keychain".to_string()),
            }),
            _ => None,
        }
    })
    .collect()
}

fn current_profile(state: &CodexState) -> Option<Profile> {
    let profile_dir = state.profile_dir.read().ok()?.clone();
    let profile_path = profile_dir.join("profile.json");
    serde_json::from_str(&std::fs::read_to_string(profile_path).ok()?).ok()
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "code": "auth.model_api_key_unavailable", "message": message.into() })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, RwLock};

    use crate::auth::{MemorySecretStore, SecretStore};
    use crate::{
        codex_auth::RefreshSingleton,
        codex_auth::{unix_now_ms, write_store, CodexCreds},
        tool_callback::{serve_with_codex, serve_with_codex_and_browser_relay},
    };
    use vulture_core::{Profile, ProfileId};

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

    #[tokio::test]
    async fn model_auth_routes_return_keychain_api_key_profiles_and_secret() {
        let dir = std::env::temp_dir().join(format!("tcb-model-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("profile.json"),
            serde_json::to_string(&Profile {
                id: ProfileId("default".to_string()),
                name: "Default".to_string(),
                openai_secret_ref: "vulture:profile:default:openai".to_string(),
                active_agent_id: "local-work-agent".to_string(),
            })
            .unwrap(),
        )
        .unwrap();
        let store = Arc::new(MemorySecretStore::default());
        store
            .set("vulture:profile:default:anthropic", "sk-ant-keychain")
            .unwrap();

        let token = "x".repeat(43);
        let handle = serve_with_codex_and_browser_relay(
            0,
            token.clone(),
            Arc::new(RwLock::new(dir.join("audit.sqlite"))),
            Arc::new(RwLock::new(dir.clone())),
            store,
            RefreshSingleton::default(),
            Arc::new(std::sync::Mutex::new(
                crate::browser::relay::BrowserRelayState::default(),
            )),
        )
        .await
        .expect("serve");
        let port = handle.bound_port;

        let client = reqwest::Client::new();
        let profiles: serde_json::Value = client
            .get(format!("http://127.0.0.1:{port}/auth/model-profiles"))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(profiles["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |profile| profile["id"] == "anthropic-api-key" && profile["status"] == "configured"
            ));

        let secret: serde_json::Value = client
            .get(format!(
                "http://127.0.0.1:{port}/auth/model-api-key/anthropic-api-key"
            ))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(secret["api_key"], "sk-ant-keychain");

        handle.shutdown().await;
        std::fs::remove_dir_all(&dir).ok();
    }
}
