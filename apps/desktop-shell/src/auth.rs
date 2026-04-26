#[cfg(test)]
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use keyring::{Entry, Error as KeyringError};
use serde::Serialize;

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
    Missing,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOpenAiApiKeyRequest {
    pub api_key: String,
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
    auth_status_with_env(
        secret_store,
        secret_ref,
        std::env::var_os("OPENAI_API_KEY").is_some(),
    )
}

fn auth_status_with_env(
    secret_store: &dyn SecretStore,
    secret_ref: &str,
    env_configured: bool,
) -> Result<OpenAiAuthStatus> {
    if secret_store.get(secret_ref)?.is_some() {
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

#[cfg(test)]
mod tests {
    use super::*;

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

        let status = auth_status_with_env(&store, "vulture:profile:default:openai", true)
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
    fn resolve_returns_missing_when_no_secret_exists() {
        let store = MemorySecretStore::default();

        let error = resolve_openai_api_key_with_env(&store, "vulture:profile:default:openai", None)
            .expect_err("missing key should fail");

        assert_eq!(error.to_string(), "OpenAI API key required.");
    }
}
