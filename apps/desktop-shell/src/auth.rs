#[cfg(test)]
use std::sync::Mutex;
use std::{fs, path::PathBuf, process::Command as StdCommand, time::Duration};

use anyhow::{anyhow, Context, Result};
use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    time::timeout,
};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentRuntimeAuth {
    ApiKey(String),
    Codex,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOpenAiApiKeyRequest {
    pub api_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginStart {
    pub verification_url: String,
    pub user_code: String,
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
        codex_chatgpt_login_available(),
    )
}

fn auth_status_with_sources(
    secret_store: &dyn SecretStore,
    secret_ref: &str,
    env_configured: bool,
    codex_configured: bool,
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

pub fn resolve_agent_runtime_auth(
    secret_store: &dyn SecretStore,
    secret_ref: &str,
) -> Result<AgentRuntimeAuth> {
    if let Ok(api_key) = resolve_openai_api_key(secret_store, secret_ref) {
        return Ok(AgentRuntimeAuth::ApiKey(api_key));
    }

    if codex_chatgpt_login_available() {
        return Ok(AgentRuntimeAuth::Codex);
    }

    Err(anyhow!("OpenAI API key or Codex ChatGPT login required."))
}

pub fn codex_chatgpt_login_available() -> bool {
    codex_login_status_reports_chatgpt().unwrap_or(false)
        || codex_auth_file_reports_chatgpt().unwrap_or(false)
}

fn codex_login_status_reports_chatgpt() -> Result<bool> {
    let output = StdCommand::new("codex")
        .args(["login", "status"])
        .output()
        .context("failed to run codex login status")?;

    if !output.status.success() {
        return Ok(false);
    }

    Ok(String::from_utf8_lossy(&output.stdout).contains("ChatGPT"))
}

fn codex_auth_file_reports_chatgpt() -> Result<bool> {
    let path = codex_auth_path()?;
    if !path.is_file() {
        return Ok(false);
    }

    let value: Value = serde_json::from_str(
        &fs::read_to_string(&path)
            .with_context(|| format!("failed to read Codex auth file at {}", path.display()))?,
    )
    .with_context(|| format!("failed to parse Codex auth file at {}", path.display()))?;

    let auth_mode_is_chatgpt = value
        .get("auth_mode")
        .and_then(Value::as_str)
        .is_some_and(|auth_mode| auth_mode.eq_ignore_ascii_case("chatgpt"));
    let has_refresh_token = value
        .get("tokens")
        .and_then(|tokens| tokens.get("refresh_token"))
        .and_then(Value::as_str)
        .is_some_and(|token| !token.trim().is_empty());

    Ok(auth_mode_is_chatgpt && has_refresh_token)
}

fn codex_auth_path() -> Result<PathBuf> {
    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(codex_home).join("auth.json"));
    }

    let home = std::env::var_os("HOME")
        .ok_or_else(|| anyhow!("HOME is not set; cannot locate Codex auth"))?;
    Ok(PathBuf::from(home).join(".codex").join("auth.json"))
}

pub async fn start_codex_login() -> Result<CodexLoginStart> {
    let mut child = Command::new("codex")
        .args(["login", "--device-auth"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("failed to start Codex login. Ensure `codex` is installed and on PATH")?;

    let stdout = child
        .stdout
        .take()
        .context("Codex login stdout was not available")?;
    let mut lines = BufReader::new(stdout).lines();

    let login = timeout(Duration::from_secs(8), async {
        let mut verification_url = None;
        let mut user_code = None;

        while let Some(line) = lines
            .next_line()
            .await
            .context("failed to read Codex login output")?
        {
            let line = strip_ansi(&line);
            if verification_url.is_none() {
                verification_url = find_verification_url(&line);
            }
            if user_code.is_none() {
                user_code = find_user_code(&line);
            }
            if let (Some(verification_url), Some(user_code)) = (&verification_url, &user_code) {
                return Ok(CodexLoginStart {
                    verification_url: verification_url.clone(),
                    user_code: user_code.clone(),
                });
            }
        }

        Err(anyhow!("Codex login did not provide a device code"))
    })
    .await
    .map_err(|_| anyhow!("Timed out waiting for Codex device login code"))??;

    open_url(&login.verification_url)?;
    wait_for_codex_login_in_background(child, lines);

    Ok(login)
}

fn wait_for_codex_login_in_background(
    mut child: tokio::process::Child,
    mut lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
) {
    tokio::spawn(async move {
        while let Ok(Some(_line)) = lines.next_line().await {}
        let _ = child.wait().await;
    });
}

fn open_url(url: &str) -> Result<()> {
    let status = StdCommand::new("open")
        .arg(url)
        .status()
        .context("failed to open Codex login URL")?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow!("failed to open Codex login URL"))
    }
}

fn find_verification_url(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|part| part.starts_with("https://auth.openai.com/codex/device"))
        .map(|part| part.trim_end_matches('.').to_string())
}

fn find_user_code(line: &str) -> Option<String> {
    let candidate = line.trim();
    if candidate.len() >= 8
        && candidate.len() <= 16
        && candidate.contains('-')
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Some(candidate.to_string());
    }

    None
}

fn strip_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            let _ = chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        output.push(ch);
    }

    output
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
    fn resolve_returns_missing_when_no_secret_exists() {
        let store = MemorySecretStore::default();

        let error = resolve_openai_api_key_with_env(&store, "vulture:profile:default:openai", None)
            .expect_err("missing key should fail");

        assert_eq!(error.to_string(), "OpenAI API key required.");
    }

    #[test]
    fn parses_codex_device_login_output() {
        let url_line = "   \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m";
        let code_line = "   \u{1b}[94m3GAR-Y26LD\u{1b}[0m";

        assert_eq!(
            find_verification_url(&strip_ansi(url_line)),
            Some("https://auth.openai.com/codex/device".to_string())
        );
        assert_eq!(
            find_user_code(&strip_ansi(code_line)),
            Some("3GAR-Y26LD".to_string())
        );
    }
}
