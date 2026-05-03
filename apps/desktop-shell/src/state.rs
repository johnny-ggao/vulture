use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, RwLock},
};

use tokio::sync::Notify;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use vulture_core::{AppPaths, Profile, ProfileId, RuntimeDescriptor, StorageLayout};

use crate::{
    auth::{
        auth_status, resolve_openai_api_key, ClearModelApiKeyRequest, KeychainSecretStore,
        OpenAiAuthStatus, SecretStore, SetModelApiKeyRequest, SetOpenAiApiKeyRequest,
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

#[derive(Clone, Debug)]
struct ActiveProfile {
    view: ProfileView,
    profile_dir: PathBuf,
    openai_secret_ref: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveProfileMarker {
    active_profile_id: String,
}

pub struct AppState {
    root: PathBuf,
    profile: RwLock<ActiveProfile>,
    profile_dir_handle: Arc<RwLock<PathBuf>>,
    audit_db_path_handle: Arc<RwLock<PathBuf>>,
    secret_store: Arc<dyn SecretStore>,
    browser_relay: Arc<Mutex<BrowserRelayState>>,
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
        let root = root.as_ref().to_path_buf();
        let default_profile = Profile::default_profile();
        let paths = AppPaths::new(&root);
        let layout = StorageLayout::new(paths);
        layout
            .ensure_profile(&default_profile)
            .context("failed to initialize default profile storage")?;
        let active_profile_id =
            read_active_profile_id(&root).unwrap_or_else(|| default_profile.id.0.clone());
        let active = load_profile(&root, &active_profile_id)
            .or_else(|_| load_profile(&root, &default_profile.id.0))
            .context("failed to load active profile")?;
        let profile_dir = layout
            .ensure_profile(&active)
            .context("failed to initialize active profile storage")?;
        write_active_profile_id(&root, &active.id.0)?;
        let current = ActiveProfile {
            view: ProfileView {
                id: active.id.0,
                name: active.name,
                active_agent_id: active.active_agent_id,
            },
            profile_dir: profile_dir.clone(),
            openai_secret_ref: active.openai_secret_ref,
        };
        let audit_db_path = audit_db_path_for_profile(&current.profile_dir);

        Ok(Self {
            root,
            profile: RwLock::new(current),
            profile_dir_handle: Arc::new(RwLock::new(profile_dir)),
            audit_db_path_handle: Arc::new(RwLock::new(audit_db_path)),
            secret_store: Arc::from(secret_store),
            browser_relay: Arc::new(Mutex::new(BrowserRelayState::default())),
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
    pub fn profile(&self) -> ProfileView {
        self.profile
            .read()
            .expect("profile lock poisoned")
            .view
            .clone()
    }

    #[allow(dead_code)]
    pub fn list_profiles(&self) -> Result<Vec<ProfileView>> {
        let profiles_dir = self.root.join("profiles");
        let mut profiles = Vec::new();
        for entry in fs::read_dir(&profiles_dir)
            .with_context(|| format!("read profiles dir {}", profiles_dir.display()))?
        {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let profile_path = entry.path().join("profile.json");
            if !profile_path.is_file() {
                continue;
            }
            let profile: Profile = serde_json::from_str(
                &fs::read_to_string(&profile_path)
                    .with_context(|| format!("read profile {}", profile_path.display()))?,
            )
            .with_context(|| format!("parse profile {}", profile_path.display()))?;
            profiles.push(ProfileView {
                id: profile.id.0,
                name: profile.name,
                active_agent_id: profile.active_agent_id,
            });
        }
        profiles.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        Ok(profiles)
    }

    #[allow(dead_code)]
    pub fn create_profile(&self, name: String) -> Result<ProfileView> {
        let name = name.trim();
        if name.is_empty() {
            return Err(anyhow!("profile name must not be empty"));
        }
        let id = self.next_profile_id(name)?;
        let profile = Profile {
            id: ProfileId(id.clone()),
            name: name.to_string(),
            openai_secret_ref: format!("vulture:profile:{id}:openai"),
            active_agent_id: "local-work-agent".to_string(),
        };
        StorageLayout::new(AppPaths::new(&self.root))
            .ensure_profile(&profile)
            .with_context(|| format!("create profile {id}"))?;
        Ok(ProfileView {
            id,
            name: profile.name,
            active_agent_id: profile.active_agent_id,
        })
    }

    #[allow(dead_code)]
    pub fn switch_profile(&self, profile_id: &str) -> Result<ProfileView> {
        let profile = load_profile(&self.root, profile_id)?;
        let profile_dir = StorageLayout::new(AppPaths::new(&self.root))
            .ensure_profile(&profile)
            .with_context(|| format!("initialize profile {}", profile.id.0))?;
        write_active_profile_id(&self.root, &profile.id.0)?;
        let view = ProfileView {
            id: profile.id.0,
            name: profile.name,
            active_agent_id: profile.active_agent_id,
        };
        let next = ActiveProfile {
            view: view.clone(),
            profile_dir: profile_dir.clone(),
            openai_secret_ref: profile.openai_secret_ref,
        };
        let audit_db_path = audit_db_path_for_profile(&next.profile_dir);
        *self.profile.write().expect("profile lock poisoned") = next;
        *self
            .profile_dir_handle
            .write()
            .expect("profile dir lock poisoned") = profile_dir;
        *self
            .audit_db_path_handle
            .write()
            .expect("audit db path lock poisoned") = audit_db_path;
        Ok(view)
    }

    fn next_profile_id(&self, name: &str) -> Result<String> {
        let mut base = String::new();
        let mut prev_dash = false;
        for ch in name.chars().flat_map(char::to_lowercase) {
            if ch.is_ascii_alphanumeric() {
                base.push(ch);
                prev_dash = false;
            } else if !prev_dash {
                base.push('-');
                prev_dash = true;
            }
        }
        let base = base.trim_matches('-');
        let base = if base.is_empty() { "profile" } else { base };
        let paths = AppPaths::new(&self.root);
        for idx in 0..1000 {
            let candidate = if idx == 0 {
                base.to_string()
            } else {
                format!("{base}-{idx}")
            };
            let dir = paths.profile_dir(&ProfileId(candidate.clone()))?;
            if !dir.exists() {
                return Ok(candidate);
            }
        }
        Ok(format!("profile-{}", uuid::Uuid::new_v4()))
    }

    pub fn openai_auth_status(&self) -> Result<OpenAiAuthStatus> {
        let secret_ref = self.openai_secret_ref();
        auth_status(self.secret_store.as_ref(), &secret_ref)
    }

    pub fn set_openai_api_key(&self, request: SetOpenAiApiKeyRequest) -> Result<OpenAiAuthStatus> {
        self.set_model_api_key(SetModelApiKeyRequest {
            profile_id: "openai-api-key".to_string(),
            api_key: request.api_key,
        })?;
        let _resolved_key = self.resolve_openai_api_key()?;
        self.openai_auth_status()
    }

    pub fn clear_openai_api_key(&self) -> Result<OpenAiAuthStatus> {
        self.clear_model_api_key(ClearModelApiKeyRequest {
            profile_id: "openai-api-key".to_string(),
        })?;
        self.openai_auth_status()
    }

    pub fn set_model_api_key(&self, request: SetModelApiKeyRequest) -> Result<()> {
        let api_key = request.api_key.trim();
        if api_key.is_empty() {
            return Err(anyhow!("model API key must not be empty"));
        }

        let secret_ref = self.model_api_key_secret_ref(&request.profile_id)?;
        self.secret_store.set(&secret_ref, api_key)?;
        Ok(())
    }

    pub fn clear_model_api_key(&self, request: ClearModelApiKeyRequest) -> Result<()> {
        let secret_ref = self.model_api_key_secret_ref(&request.profile_id)?;
        self.secret_store.clear(&secret_ref)?;
        Ok(())
    }

    pub fn resolve_openai_api_key(&self) -> Result<String> {
        let secret_ref = self.openai_secret_ref();
        resolve_openai_api_key(self.secret_store.as_ref(), &secret_ref)
    }

    pub fn browser_status(&self) -> Result<BrowserRelayStatus> {
        Ok(self.browser_relay()?.status())
    }

    pub fn start_browser_pairing(&self) -> Result<BrowserRelayStatus> {
        let relay_port = self
            .runtime_descriptor()
            .map(|descriptor| descriptor.shell.port)
            .ok_or_else(|| anyhow!("runtime descriptor is not ready"))?;
        self.browser_relay()?.enable_pairing(relay_port)
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
        self.runtime_descriptor
            .read()
            .expect("rt lock poisoned")
            .clone()
    }

    pub fn supervisor_status(&self) -> SupervisorStatus {
        self.supervisor_status
            .read()
            .expect("sup lock poisoned")
            .clone()
    }

    /// Hand the supervisor task a write handle to the status so it can publish
    /// state transitions without going through `&AppState`.
    pub fn supervisor_status_handle(&self) -> Arc<RwLock<SupervisorStatus>> {
        self.supervisor_status.clone()
    }

    pub fn profile_dir(&self) -> PathBuf {
        self.profile
            .read()
            .expect("profile lock poisoned")
            .profile_dir
            .clone()
    }

    pub fn profile_dir_handle(&self) -> Arc<RwLock<PathBuf>> {
        self.profile_dir_handle.clone()
    }

    pub fn audit_db_path_handle(&self) -> Arc<RwLock<PathBuf>> {
        self.audit_db_path_handle.clone()
    }

    pub fn browser_relay_handle(&self) -> Arc<Mutex<BrowserRelayState>> {
        self.browser_relay.clone()
    }

    pub fn secret_store(&self) -> &dyn SecretStore {
        self.secret_store.as_ref()
    }

    pub fn secret_store_handle(&self) -> Arc<dyn SecretStore> {
        Arc::clone(&self.secret_store)
    }

    pub fn openai_secret_ref(&self) -> String {
        self.profile
            .read()
            .expect("profile lock poisoned")
            .openai_secret_ref
            .clone()
    }

    pub fn model_api_key_secret_ref(&self, profile_id: &str) -> Result<String> {
        let profile = self.profile.read().expect("profile lock poisoned");
        model_api_key_secret_ref(&profile.view.id, &profile.openai_secret_ref, profile_id)
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

fn load_profile(root: &Path, profile_id: &str) -> Result<Profile> {
    let profile_dir = AppPaths::new(root).profile_dir(&ProfileId(profile_id.to_string()))?;
    let profile_path = profile_dir.join("profile.json");
    let profile: Profile = serde_json::from_str(
        &fs::read_to_string(&profile_path)
            .with_context(|| format!("failed to read profile at {}", profile_path.display()))?,
    )
    .with_context(|| format!("failed to parse profile at {}", profile_path.display()))?;
    Ok(profile)
}

pub fn model_api_key_secret_ref(
    profile_id: &str,
    openai_secret_ref: &str,
    model_profile_id: &str,
) -> Result<String> {
    match model_profile_id {
        "openai-api-key" => Ok(openai_secret_ref.to_string()),
        "anthropic-api-key" => Ok(format!("vulture:profile:{profile_id}:anthropic")),
        _ => Err(anyhow!(
            "unsupported model API key profile: {model_profile_id}"
        )),
    }
}

fn read_active_profile_id(root: &Path) -> Option<String> {
    let path = root.join("profiles").join("active_profile.json");
    let marker: ActiveProfileMarker = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    Some(marker.active_profile_id)
}

fn write_active_profile_id(root: &Path, profile_id: &str) -> Result<()> {
    let profiles_dir = root.join("profiles");
    fs::create_dir_all(&profiles_dir)?;
    let marker = ActiveProfileMarker {
        active_profile_id: profile_id.to_string(),
    };
    fs::write(
        profiles_dir.join("active_profile.json"),
        serde_json::to_string_pretty(&marker)?,
    )?;
    Ok(())
}

fn audit_db_path_for_profile(profile_dir: &Path) -> PathBuf {
    profile_dir.join("permissions").join("audit.sqlite")
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

    #[test]
    fn new_for_root_restores_active_profile_marker() {
        let root = temp_root();
        let profiles_dir = root.join("profiles");
        let work_dir = profiles_dir.join("work");
        fs::create_dir_all(&work_dir).expect("profile dir should be created");
        let profile = Profile {
            id: vulture_core::ProfileId("work".to_string()),
            name: "Work".to_string(),
            openai_secret_ref: "vulture:profile:work:openai".to_string(),
            active_agent_id: "local-work-agent".to_string(),
        };
        fs::write(
            work_dir.join("profile.json"),
            serde_json::to_string_pretty(&profile).expect("profile should serialize"),
        )
        .expect("profile json should be seeded");
        fs::write(
            profiles_dir.join("active_profile.json"),
            serde_json::json!({ "activeProfileId": "work" }).to_string(),
        )
        .expect("active profile marker should be seeded");

        let state = AppState::new_for_root(&root).expect("app state should initialize");

        assert_eq!(state.profile().id, "work");
        assert_eq!(state.profile().name, "Work");
        assert_eq!(state.profile_dir(), work_dir);

        fs::remove_dir_all(root).expect("test root should be removable");
    }

    #[test]
    fn profile_switch_updates_directory_and_keeps_api_keys_isolated() {
        let root = temp_root();
        let state =
            AppState::new_for_root_with_secret_store(&root, Box::new(MemorySecretStore::default()))
                .expect("app state should initialize");

        state
            .set_openai_api_key(SetOpenAiApiKeyRequest {
                api_key: "sk-default".to_string(),
            })
            .expect("default key should save");
        let created = state
            .create_profile("Work".to_string())
            .expect("profile should be created");

        state
            .switch_profile(&created.id)
            .expect("switch should succeed");
        assert_eq!(state.profile().id, created.id);
        assert_eq!(state.profile_dir(), root.join("profiles").join(&created.id));
        assert_eq!(
            *state
                .audit_db_path_handle()
                .read()
                .expect("audit db path lock should not be poisoned"),
            root.join("profiles")
                .join(&created.id)
                .join("permissions/audit.sqlite")
        );
        assert!(matches!(
            state
                .openai_auth_status()
                .expect("status should resolve")
                .source,
            AuthSource::Missing | AuthSource::Codex
        ));

        state
            .set_openai_api_key(SetOpenAiApiKeyRequest {
                api_key: "sk-work".to_string(),
            })
            .expect("work key should save");
        assert_eq!(
            state
                .resolve_openai_api_key()
                .expect("work key should resolve"),
            "sk-work"
        );

        state
            .switch_profile("default")
            .expect("switch back should succeed");
        assert_eq!(state.profile().id, "default");
        assert_eq!(
            state
                .resolve_openai_api_key()
                .expect("default key should resolve"),
            "sk-default"
        );

        let active_marker = fs::read_to_string(root.join("profiles/active_profile.json"))
            .expect("active marker should exist");
        assert!(active_marker.contains("\"default\""));

        fs::remove_dir_all(root).expect("test root should be removable");
    }
}
