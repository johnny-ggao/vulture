use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::TcpListener,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use vulture_core::RuntimeDescriptor;

pub const TOKEN_BYTES: usize = 32;

/// 32 bytes URL-safe base64 → 43 chars (no padding). Asserted by tests + the
/// shared `RuntimeDescriptor` schema.
#[allow(dead_code)] // referenced from tests and as documentation of the contract
pub const TOKEN_B64_LEN: usize = 43;

pub fn vulture_root_from_env(
    env: &impl Fn(&str) -> Option<std::ffi::OsString>,
) -> std::path::PathBuf {
    if let Some(value) = env("VULTURE_DESKTOP_ROOT") {
        return PathBuf::from(value);
    }

    let home = env("HOME").expect("HOME must be set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Vulture")
}

pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Linear scan starting at `start`, trying up to `window` ports.
/// Returns the first free port. SECURITY: binds 127.0.0.1 only.
pub fn pick_free_port(start: u16, window: u16) -> anyhow::Result<u16> {
    for offset in 0..window {
        let port = start.saturating_add(offset);
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(anyhow::anyhow!(
        "no free port in 127.0.0.1:{start}-{}",
        start.saturating_add(window).saturating_sub(1)
    ))
}

pub fn write_runtime_json(
    path: impl AsRef<Path>,
    descriptor: &RuntimeDescriptor,
) -> anyhow::Result<()> {
    let path = path.as_ref();
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("runtime path has no parent"))?;
    fs::create_dir_all(parent)?;

    let tmp = path.with_extension("json.tmp");
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        serde_json::to_writer_pretty(&mut file, descriptor)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Mirrors `write_runtime_json` for callers that want to inspect a previously
/// written descriptor. Used by integration tests + Phase 2 CLI.
#[allow(dead_code)]
pub fn read_runtime_json(path: impl AsRef<Path>) -> anyhow::Result<RuntimeDescriptor> {
    let raw = fs::read_to_string(path.as_ref())?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn remove_runtime_json(path: impl AsRef<Path>) {
    let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn token_has_expected_length() {
        let t = generate_token();
        assert_eq!(t.len(), TOKEN_B64_LEN);
    }

    #[test]
    fn tokens_are_url_safe_base64() {
        let t = generate_token();
        for ch in t.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || ch == '-' || ch == '_',
                "unexpected char: {ch}"
            );
        }
    }

    #[test]
    fn tokens_are_unique_across_many_calls() {
        let mut seen = HashSet::new();
        for _ in 0..1024 {
            assert!(seen.insert(generate_token()), "duplicate token");
        }
    }

    #[test]
    fn root_uses_vulture_desktop_root_when_set() {
        let root = vulture_root_from_env(&|key| match key {
            "VULTURE_DESKTOP_ROOT" => Some("/tmp/vulture-e2e-root".into()),
            "HOME" => Some("/Users/example".into()),
            _ => None,
        });

        assert_eq!(root, std::path::PathBuf::from("/tmp/vulture-e2e-root"));
    }

    #[test]
    fn root_falls_back_to_application_support() {
        let root = vulture_root_from_env(&|key| match key {
            "HOME" => Some("/Users/example".into()),
            _ => None,
        });

        assert_eq!(
            root,
            std::path::PathBuf::from("/Users/example")
                .join("Library")
                .join("Application Support")
                .join("Vulture")
        );
    }

    #[test]
    fn picks_a_free_port_in_range() {
        let port = pick_free_port(40000, 100).expect("should find free port");
        assert!((40000..40100).contains(&port));
    }

    #[test]
    fn skips_occupied_ports() {
        use std::net::TcpListener;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let occupied = listener.local_addr().unwrap().port();
        let picked = pick_free_port(occupied, 5).expect("falls through occupied");
        assert_ne!(picked, occupied);
    }

    #[test]
    fn writes_runtime_json_with_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "vulture-runtime-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runtime.json");

        let descriptor = vulture_core::RuntimeDescriptor {
            api_version: vulture_core::API_VERSION.to_string(),
            gateway: vulture_core::PortBinding { port: 4099 },
            shell: vulture_core::PortBinding { port: 4199 },
            token: "x".repeat(TOKEN_B64_LEN),
            pid: std::process::id(),
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            shell_version: env!("CARGO_PKG_VERSION").to_string(),
        };

        write_runtime_json(&path, &descriptor).expect("write should succeed");

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "runtime.json must be 0600");

        let parsed = read_runtime_json(&path).expect("read should succeed");
        assert_eq!(parsed, descriptor);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_is_atomic_via_tmp_rename() {
        let dir = std::env::temp_dir().join(format!(
            "vulture-runtime-atomic-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runtime.json");
        let tmp = dir.join("runtime.json.tmp");

        let descriptor = vulture_core::RuntimeDescriptor {
            api_version: vulture_core::API_VERSION.to_string(),
            gateway: vulture_core::PortBinding { port: 4099 },
            shell: vulture_core::PortBinding { port: 4199 },
            token: "x".repeat(TOKEN_B64_LEN),
            pid: 1,
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            shell_version: "0".to_string(),
        };
        write_runtime_json(&path, &descriptor).unwrap();
        assert!(path.exists());
        assert!(!tmp.exists(), "tmp should be cleaned up");
        std::fs::remove_dir_all(&dir).ok();
    }
}
