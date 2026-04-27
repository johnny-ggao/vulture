use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Snapshot of the credentials persisted at <profile_dir>/codex_auth.json.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct CodexCreds {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub account_id: String,
    #[serde(default)]
    pub email: Option<String>,
    /// Unix epoch milliseconds.
    pub expires_at: u64,
    pub stored_at: u64,
    #[serde(default)]
    pub imported_from: Option<String>,
}

const STORE_FILE_NAME: &str = "codex_auth.json";

pub fn store_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(STORE_FILE_NAME)
}

pub fn read_store(profile_dir: &Path) -> Result<Option<CodexCreds>> {
    let path = store_path(profile_dir);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read_to_string(&path)
        .with_context(|| format!("read {}", path.display()))?;
    let creds: CodexCreds = serde_json::from_str(&bytes)
        .with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(creds))
}

/// Atomic write: tmp file + rename. Sets mode 0600 on Unix.
pub fn write_store(profile_dir: &Path, creds: &CodexCreds) -> Result<()> {
    let path = store_path(profile_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("mkdir {}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(creds)?;
    std::fs::write(&tmp, &bytes).with_context(|| format!("write {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(&tmp)?;
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&tmp, perms)?;
    }
    std::fs::rename(&tmp, &path).with_context(|| format!("rename {}", path.display()))?;
    Ok(())
}

pub fn delete_store(profile_dir: &Path) -> Result<()> {
    let path = store_path(profile_dir);
    if path.is_file() {
        std::fs::remove_file(&path)
            .with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

pub fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Detect ~/.codex/auth.json (Codex CLI's store) and copy creds if our store
/// is missing. One-time only; subsequent refreshes do not write back to ~/.codex.
pub fn ensure_store_with_import(profile_dir: &Path) -> Result<()> {
    let our = store_path(profile_dir);
    if our.is_file() {
        return Ok(());
    }
    let codex = home_dir()?
        .join(".codex")
        .join("auth.json");
    if !codex.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&codex)
        .with_context(|| format!("read {}", codex.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let tokens = value
        .get("tokens")
        .ok_or_else(|| anyhow!("~/.codex/auth.json missing 'tokens' field"))?;
    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing tokens.access_token"))?
        .to_string();
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing tokens.refresh_token"))?
        .to_string();
    let id_token = tokens
        .get("id_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing tokens.id_token"))?
        .to_string();
    let account_id = tokens
        .get("account_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing tokens.account_id"))?
        .to_string();
    // Codex CLI doesn't store expires_at directly — we infer from JWT exp claim
    // for imported creds. If JWT decode fails, default to 1h from now (safe;
    // a refresh will run shortly).
    let expires_at = expires_at_from_jwt(&access_token).unwrap_or_else(|| unix_now_ms() + 3_600_000);
    let creds = CodexCreds {
        access_token,
        refresh_token,
        id_token,
        account_id,
        email: None,
        expires_at,
        stored_at: unix_now_ms(),
        imported_from: Some("~/.codex/auth.json".into()),
    };
    write_store(profile_dir, &creds)?;
    Ok(())
}

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is not set"))
}

/// Parse `exp` claim from JWT (no signature verification). Returns ms epoch.
fn expires_at_from_jwt(jwt: &str) -> Option<u64> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    let exp = value.get("exp")?.as_u64()?;
    Some(exp * 1000)  // exp is seconds, we use ms
}

#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl Pkce {
    pub fn generate() -> Self {
        let mut verifier_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut verifier_bytes);
        let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);

        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());

        let mut state_bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut state_bytes);
        let state = URL_SAFE_NO_PAD.encode(state_bytes);

        Self { verifier, challenge, state }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_profile() -> PathBuf {
        std::env::temp_dir().join(format!("vulture-codex-auth-{}", Uuid::new_v4()))
    }

    fn sample_creds() -> CodexCreds {
        CodexCreds {
            access_token: "at-1".into(),
            refresh_token: "rt-1".into(),
            id_token: "id-1".into(),
            account_id: "acc-1".into(),
            email: Some("user@example.com".into()),
            expires_at: 1_714_238_400_000,
            stored_at: 1_714_234_800_000,
            imported_from: None,
        }
    }

    #[test]
    fn read_store_returns_none_when_missing() {
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        assert!(read_store(&profile).unwrap().is_none());
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn write_then_read_round_trips() {
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        let creds = sample_creds();
        write_store(&profile, &creds).expect("write");
        let read = read_store(&profile).expect("read").expect("Some");
        assert_eq!(read, creds);
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn write_sets_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        write_store(&profile, &sample_creds()).expect("write");
        let metadata = std::fs::metadata(store_path(&profile)).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn delete_store_removes_file() {
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        write_store(&profile, &sample_creds()).expect("write");
        assert!(store_path(&profile).is_file());
        delete_store(&profile).expect("delete");
        assert!(!store_path(&profile).is_file());
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn ensure_store_with_import_no_op_if_our_store_exists() {
        let profile = temp_profile();
        std::fs::create_dir_all(&profile).unwrap();
        let original = sample_creds();
        write_store(&profile, &original).expect("write our store first");
        ensure_store_with_import(&profile).expect("import");
        let read = read_store(&profile).expect("read").expect("Some");
        assert_eq!(read, original);  // unchanged
        std::fs::remove_dir_all(&profile).ok();
    }

    #[test]
    fn pkce_challenge_is_base64url_sha256_of_verifier() {
        let pkce = Pkce::generate();
        // verifier is 32 bytes base64url-encoded → 43 chars no padding
        assert_eq!(pkce.verifier.len(), 43);
        // challenge is sha256(verifier) base64url-encoded → also 43 chars no padding
        assert_eq!(pkce.challenge.len(), 43);
        // Verify the relationship: re-derive challenge from verifier
        use sha2::{Digest, Sha256};
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let mut hasher = Sha256::new();
        hasher.update(pkce.verifier.as_bytes());
        let derived = URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(pkce.challenge, derived);
    }

    #[test]
    fn pkce_state_is_unique() {
        let a = Pkce::generate();
        let b = Pkce::generate();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.state, b.state);
    }

    #[test]
    fn pkce_state_is_url_safe() {
        let pkce = Pkce::generate();
        assert!(pkce.state.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
