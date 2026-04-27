use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, RwLock},
};

use tokio::sync::Notify;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use vulture_core::{AppPaths, Profile, RuntimeDescriptor, StorageLayout};

use crate::{
    auth::{
        auth_status, resolve_openai_api_key,
        KeychainSecretStore, OpenAiAuthStatus, SecretStore, SetOpenAiApiKeyRequest,
    },
    browser::relay::{BrowserRelayState, BrowserRelayStatus},
    codex_auth::RefreshSingleton,
    supervisor::SupervisorStatus,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    pub active_agent_id: String,
}

pub struct AppState {
    #[allow(dead_code)]
    profile: ProfileView,
    profile_dir: PathBuf,
    openai_secret_ref: String,
    secret_store: Box<dyn SecretStore>,
    browser_relay: Mutex<BrowserRelayState>,
    runtime_descriptor: RwLock<Option<RuntimeDescriptor>>,
    /// Shared with the supervisor task so the loop can publish state transitions
    /// (Starting → Running → Restarting → Faulted) that the UI reads via the
    /// `get_supervisor_status` Tauri command.
    supervisor_status: Arc<RwLock<SupervisorStatus>>,
    /// Notified by the `restart_gateway` command to wake the supervisor loop
    /// from its backoff sleep.
    restart_signal: Arc<Notify>,
    /// Notified on Tauri exit so the supervisor loop can SIGTERM the gateway
    /// and unwind cleanly before the process exits.
    shutdown_signal: Arc<Notify>,
    /// Concurrency-safe Codex refresh primitive: ensures only one HTTP refresh
    /// to OpenAI's token endpoint is in flight at any given time. Shared across
    /// all callers (gateway processes, Tauri commands).
    ///
    /// Wired into Tauri commands in Task 7 — the field is stored here so future
    /// callers (`refresh_codex_creds`, etc.) can `clone()` and reuse the same
    /// in-flight tracker across the whole desktop process.
    pub codex_refresh: RefreshSingleton,
}

impl AppState {
    #[allow(dead_code)]
    pub fn new() -> Result<Self> {
        let home = std::env::var_os("HOME").ok_or_else(|| {
            anyhow!("HOME is not set; cannot resolve Vulture application support directory")
        })?;
        let root = PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Vulture");

        Self::new_for_root(root)
    }

    pub fn new_for_root(root: impl AsRef<Path>) -> Result<Self> {
        Self::new_for_root_with_secret_store(root, Box::new(KeychainSecretStore))
    }

    pub fn new_for_root_with_secret_store(
        root: impl AsRef<Path>,
        secret_store: Box<dyn SecretStore>,
    ) -> Result<Self> {
        let profile = Profile::default_profile();
        let paths = AppPaths::new(root.as_ref());
        let layout = StorageLayout::new(paths);
        let profile_dir = layout
            .ensure_profile(&profile)
            .context("failed to initialize default profile storage")?;
        let profile_path = profile_dir.join("profile.json");
        let profile: Profile =
            serde_json::from_str(&fs::read_to_string(&profile_path).with_context(|| {
                format!("failed to read profile at {}", profile_path.display())
            })?)
            .with_context(|| format!("failed to parse profile at {}", profile_path.display()))?;
        let openai_secret_ref = profile.openai_secret_ref.clone();

        Ok(Self {
            profile: ProfileView {
                id: profile.id.0,
                name: profile.name,
                active_agent_id: profile.active_agent_id,
            },
            profile_dir,
            openai_secret_ref,
            secret_store,
            browser_relay: Mutex::new(BrowserRelayState::default()),
            runtime_descriptor: RwLock::new(None),
            supervisor_status: Arc::new(RwLock::new(SupervisorStatus {
                state: crate::supervisor::SupervisorState::Starting,
                gateway_log: None,
            })),
            restart_signal: Arc::new(Notify::new()),
            shutdown_signal: Arc::new(Notify::new()),
            codex_refresh: RefreshSingleton::default(),
        })
    }

    #[allow(dead_code)]
    pub fn profile(&self) -> &ProfileView {
        &self.profile
    }

    pub fn openai_auth_status(&self) -> Result<OpenAiAuthStatus> {
        auth_status(self.secret_store.as_ref(), &self.openai_secret_ref)
    }

    pub fn set_openai_api_key(&self, request: SetOpenAiApiKeyRequest) -> Result<OpenAiAuthStatus> {
        let api_key = request.api_key.trim();
        if api_key.is_empty() {
            return Err(anyhow!("OpenAI API key must not be empty"));
        }

        self.secret_store.set(&self.openai_secret_ref, api_key)?;
        let _resolved_key = self.resolve_openai_api_key()?;
        self.openai_auth_status()
    }

    pub fn clear_openai_api_key(&self) -> Result<OpenAiAuthStatus> {
        self.secret_store.clear(&self.openai_secret_ref)?;
        self.openai_auth_status()
    }

    pub fn resolve_openai_api_key(&self) -> Result<String> {
        resolve_openai_api_key(self.secret_store.as_ref(), &self.openai_secret_ref)
    }

    pub fn browser_status(&self) -> Result<BrowserRelayStatus> {
        Ok(self.browser_relay()?.status())
    }

    pub fn start_browser_pairing(&self) -> Result<BrowserRelayStatus> {
        self.browser_relay()?.enable_pairing(38421)
    }

    fn browser_relay(&self) -> Result<MutexGuard<'_, BrowserRelayState>> {
        self.browser_relay
            .lock()
            .map_err(|_| anyhow!("browser relay lock poisoned"))
    }

}

impl AppState {
    pub fn set_runtime_descriptor(&self, descriptor: RuntimeDescriptor) {
        *self.runtime_descriptor.write().expect("rt lock poisoned") = Some(descriptor);
    }

    pub fn runtime_descriptor(&self) -> Option<RuntimeDescriptor> {
        self.runtime_descriptor.read().expect("rt lock poisoned").clone()
    }

    pub fn supervisor_status(&self) -> SupervisorStatus {
        self.supervisor_status.read().expect("sup lock poisoned").clone()
    }

    /// Hand the supervisor task a write handle to the status so it can publish
    /// state transitions without going through `&AppState`.
    pub fn supervisor_status_handle(&self) -> Arc<RwLock<SupervisorStatus>> {
        self.supervisor_status.clone()
    }

    pub fn profile_dir(&self) -> PathBuf {
        self.profile_dir.clone()
    }

    pub fn request_supervisor_restart(&self) {
        self.restart_signal.notify_one();
    }

    pub fn restart_signal(&self) -> Arc<Notify> {
        self.restart_signal.clone()
    }

    pub fn shutdown_signal(&self) -> Arc<Notify> {
        self.shutdown_signal.clone()
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    use crate::auth::{AuthSource, MemorySecretStore};

    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("vulture-desktop-state-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn new_for_root_creates_profile_json() {
        let root = temp_root();

        let state = AppState::new_for_root(&root).expect("app state should initialize");

        assert_eq!(state.profile().id, "default");
        assert_eq!(state.profile().name, "Default");
        assert_eq!(state.profile().active_agent_id, "local-work-agent");
        assert!(root.join("profiles/default/profile.json").is_file());

        fs::remove_dir_all(root).expect("test root should be removable");
    }

    #[test]
    fn new_for_root_loads_existing_profile_json() {
        let root = temp_root();
        let profile_dir = root.join("profiles/default");
        fs::create_dir_all(&profile_dir).expect("profile dir should be created");
        let profile = Profile {
            id: vulture_core::ProfileId("default".to_string()),
            name: "Persisted Profile".to_string(),
            openai_secret_ref: "vulture:profile:default:openai".to_string(),
            active_agent_id: "persisted-agent".to_string(),
        };
        fs::write(
            profile_dir.join("profile.json"),
            serde_json::to_string_pretty(&profile).expect("profile should serialize"),
        )
        .expect("profile json should be seeded");

        let state = AppState::new_for_root(&root).expect("app state should initialize");

        assert_eq!(state.profile().id, "default");
        assert_eq!(state.profile().name, "Persisted Profile");
        assert_eq!(state.profile().active_agent_id, "persisted-agent");

        fs::remove_dir_all(root).expect("test root should be removable");
    }

    // NOTE: persists_agents_and_workspaces_under_profile_dir was removed —
    // agent + workspace storage moved to the gateway in Phase 2 and is now
    // exercised by gateway/src/domain/{agent,workspace}Store.test.ts.

    #[test]
    fn stores_openai_api_key_in_secret_store() {
        let root = temp_root();
        let state =
            AppState::new_for_root_with_secret_store(&root, Box::new(MemorySecretStore::default()))
                .expect("app state should initialize");

        let missing = state
            .openai_auth_status()
            .expect("status should resolve before key save");
        let configured = state
            .set_openai_api_key(SetOpenAiApiKeyRequest {
                api_key: " sk-test ".to_string(),
            })
            .expect("api key should save");

        assert!(matches!(
            missing.source,
            AuthSource::Missing | AuthSource::Codex
        ));
        assert_eq!(configured.source, AuthSource::Keychain);
        assert_eq!(
            state
                .resolve_openai_api_key()
                .expect("api key should resolve"),
            "sk-test"
        );

        fs::remove_dir_all(root).expect("test root should be removable");
    }
}
