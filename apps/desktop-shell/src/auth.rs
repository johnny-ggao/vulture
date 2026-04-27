#[cfg(test)]
use std::sync::Mutex;
use std::path::Path;

use anyhow::{anyhow, Result};
use keyring::{Entry, Error as KeyringError};
use serde::Serialize;

use crate::codex_auth::{read_store, unix_now_ms};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiAuthStatus {
    pub configured: bool,
    pub source: AuthSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthSource {
    Keychain,
    Environment,
    Codex,
    Missing,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOpenAiApiKeyRequest {
    pub api_key: String,
}

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
    #[allow(dead_code)]
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

pub trait SecretStore: Send + Sync {
    fn get(&self, secret_ref: &str) -> Result<Option<String>>;
    fn set(&self, secret_ref: &str, value: &str) -> Result<()>;
    fn clear(&self, secret_ref: &str) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct KeychainSecretStore;

impl SecretStore for KeychainSecretStore {
    fn get(&self, secret_ref: &str) -> Result<Option<String>> {
        match Entry::new("dev.vulture.desktop", secret_ref)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn set(&self, secret_ref: &str, value: &str) -> Result<()> {
        Entry::new("dev.vulture.desktop", secret_ref)?.set_password(value)?;
        Ok(())
    }

    fn clear(&self, secret_ref: &str) -> Result<()> {
        match Entry::new("dev.vulture.desktop", secret_ref)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    value: Mutex<Option<String>>,
}

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn get(&self, _secret_ref: &str) -> Result<Option<String>> {
        self.value
            .lock()
            .map_err(|_| anyhow!("memory secret store lock poisoned"))
            .map(|value| value.clone())
    }

    fn set(&self, _secret_ref: &str, value: &str) -> Result<()> {
        *self
            .value
            .lock()
            .map_err(|_| anyhow!("memory secret store lock poisoned"))? = Some(value.to_string());
        Ok(())
    }

    fn clear(&self, _secret_ref: &str) -> Result<()> {
        *self
            .value
            .lock()
            .map_err(|_| anyhow!("memory secret store lock poisoned"))? = None;
        Ok(())
    }
}

pub fn auth_status(secret_store: &dyn SecretStore, secret_ref: &str) -> Result<OpenAiAuthStatus> {
    auth_status_with_sources(
        secret_store,
        secret_ref,
        std::env::var_os("OPENAI_API_KEY").is_some(),
        false,
    )
}

fn auth_status_with_sources(
    secret_store: &dyn SecretStore,
    secret_ref: &str,
    env_configured: bool,
    codex_configured: bool,
) -> Result<OpenAiAuthStatus> {
    if matches!(secret_store.get(secret_ref), Ok(Some(_))) {
        return Ok(OpenAiAuthStatus {
            configured: true,
            source: AuthSource::Keychain,
        });
    }

    if env_configured {
        return Ok(OpenAiAuthStatus {
            configured: true,
            source: AuthSource::Environment,
        });
    }

    if codex_configured {
        return Ok(OpenAiAuthStatus {
            configured: true,
            source: AuthSource::Codex,
        });
    }

    Ok(OpenAiAuthStatus {
        configured: false,
        source: AuthSource::Missing,
    })
}

pub fn resolve_openai_api_key(secret_store: &dyn SecretStore, secret_ref: &str) -> Result<String> {
    resolve_openai_api_key_with_env(
        secret_store,
        secret_ref,
        std::env::var("OPENAI_API_KEY").ok(),
    )
}

fn resolve_openai_api_key_with_env(
    secret_store: &dyn SecretStore,
    secret_ref: &str,
    env_key: Option<String>,
) -> Result<String> {
    if let Some(value) = secret_store.get(secret_ref)? {
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }

    if let Some(value) = env_key {
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }

    Err(anyhow!("OpenAI API key required."))
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

#[cfg(test)]
mod tests {
    use super::*;

    struct FailingSecretStore;

    impl SecretStore for FailingSecretStore {
        fn get(&self, _secret_ref: &str) -> Result<Option<String>> {
            Err(anyhow!("keychain unavailable"))
        }

        fn set(&self, _secret_ref: &str, _value: &str) -> Result<()> {
            Err(anyhow!("keychain unavailable"))
        }

        fn clear(&self, _secret_ref: &str) -> Result<()> {
            Err(anyhow!("keychain unavailable"))
        }
    }

    #[test]
    fn status_reports_keychain_when_secret_exists() {
        let store = MemorySecretStore::default();
        store
            .set("vulture:profile:default:openai", "sk-test")
            .expect("secret should save");

        let status =
            auth_status(&store, "vulture:profile:default:openai").expect("status should resolve");

        assert_eq!(
            status,
            OpenAiAuthStatus {
                configured: true,
                source: AuthSource::Keychain,
            }
        );
    }

    #[test]
    fn status_reports_environment_when_secret_missing() {
        let store = MemorySecretStore::default();

        let status =
            auth_status_with_sources(&store, "vulture:profile:default:openai", true, false)
                .expect("status should resolve");

        assert_eq!(
            status,
            OpenAiAuthStatus {
                configured: true,
                source: AuthSource::Environment,
            }
        );
    }

    #[test]
    fn status_reports_codex_when_api_key_missing() {
        let store = MemorySecretStore::default();

        let status =
            auth_status_with_sources(&store, "vulture:profile:default:openai", false, true)
                .expect("status should resolve");

        assert_eq!(
            status,
            OpenAiAuthStatus {
                configured: true,
                source: AuthSource::Codex,
            }
        );
    }

    #[test]
    fn status_falls_back_to_codex_when_keychain_status_read_fails() {
        let status = auth_status_with_sources(
            &FailingSecretStore,
            "vulture:profile:default:openai",
            false,
            true,
        )
        .expect("status should fall back to codex");

        assert_eq!(
            status,
            OpenAiAuthStatus {
                configured: true,
                source: AuthSource::Codex,
            }
        );
    }

    #[test]
    fn resolve_returns_missing_when_no_secret_exists() {
        let store = MemorySecretStore::default();

        let error = resolve_openai_api_key_with_env(&store, "vulture:profile:default:openai", None)
            .expect_err("missing key should fail");

        assert_eq!(error.to_string(), "OpenAI API key required.");
    }
}
