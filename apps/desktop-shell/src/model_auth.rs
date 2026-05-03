use std::collections::BTreeMap;

use serde::Serialize;

use crate::codex_auth::CodexCreds;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelAuthProfileView {
    pub id: String,
    pub provider: String,
    pub mode: String,
    pub label: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelAuthProfilesResponse {
    pub profiles: Vec<ModelAuthProfileView>,
    pub auth_order: BTreeMap<String, Vec<String>>,
}

pub fn project_model_auth_profiles(
    codex_creds: Option<CodexCreds>,
    now_ms: u64,
) -> ModelAuthProfilesResponse {
    let Some(creds) = codex_creds else {
        return ModelAuthProfilesResponse {
            profiles: Vec::new(),
            auth_order: BTreeMap::new(),
        };
    };

    let profile_id = "codex".to_string();
    let provider = "openai".to_string();
    let status = if creds.expires_at <= now_ms {
        "expired"
    } else {
        "configured"
    }
    .to_string();

    let mut auth_order = BTreeMap::new();
    auth_order.insert(provider.clone(), vec![profile_id.clone()]);

    ModelAuthProfilesResponse {
        profiles: vec![ModelAuthProfileView {
            id: profile_id,
            provider,
            mode: "oauth".to_string(),
            label: "ChatGPT / Codex".to_string(),
            status,
            email: creds.email,
            expires_at: Some(creds.expires_at),
            source: creds.imported_from,
        }],
        auth_order,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_creds(expires_at: u64) -> CodexCreds {
        CodexCreds {
            access_token: "access".to_string(),
            refresh_token: "refresh".to_string(),
            id_token: "id".to_string(),
            account_id: "account".to_string(),
            email: Some("dev@example.com".to_string()),
            expires_at,
            stored_at: 1_000,
            imported_from: Some("~/.codex/auth.json".to_string()),
        }
    }

    #[test]
    fn projects_configured_codex_profile() {
        let response = project_model_auth_profiles(Some(sample_creds(2_000)), 1_999);

        assert_eq!(response.profiles.len(), 1);
        assert_eq!(
            response.profiles[0],
            ModelAuthProfileView {
                id: "codex".to_string(),
                provider: "openai".to_string(),
                mode: "oauth".to_string(),
                label: "ChatGPT / Codex".to_string(),
                status: "configured".to_string(),
                email: Some("dev@example.com".to_string()),
                expires_at: Some(2_000),
                source: Some("~/.codex/auth.json".to_string()),
            }
        );
        assert_eq!(
            response.auth_order.get("openai"),
            Some(&vec!["codex".to_string()])
        );
    }

    #[test]
    fn projects_expired_codex_profile() {
        let response = project_model_auth_profiles(Some(sample_creds(2_000)), 2_000);

        assert_eq!(response.profiles.len(), 1);
        assert_eq!(response.profiles[0].status, "expired");
        assert_eq!(
            response.auth_order.get("openai"),
            Some(&vec!["codex".to_string()])
        );
    }

    #[test]
    fn no_creds_returns_empty_response() {
        let response = project_model_auth_profiles(None, 2_000);

        assert!(response.profiles.is_empty());
        assert!(response.auth_order.is_empty());
    }
}
