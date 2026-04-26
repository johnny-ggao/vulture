use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::json;
use vulture_core::{AppPaths, Profile, StorageLayout};
use vulture_tool_gateway::{AuditStore, PolicyDecision, PolicyEngine, ToolRequest};

use crate::{
    agent_store::{AgentStore, AgentView, SaveAgentRequest},
    auth::{
        auth_status, resolve_openai_api_key, KeychainSecretStore, OpenAiAuthStatus, SecretStore,
        SetOpenAiApiKeyRequest,
    },
    browser::relay::{BrowserRelayState, BrowserRelayStatus},
    workspace_store::{SaveWorkspaceRequest, WorkspaceStore},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    pub active_agent_id: String,
}

pub struct AppState {
    profile: ProfileView,
    profile_dir: PathBuf,
    openai_secret_ref: String,
    secret_store: Box<dyn SecretStore>,
    policy_engine: PolicyEngine,
    audit_store: Mutex<AuditStore>,
    browser_relay: Mutex<BrowserRelayState>,
}

impl AppState {
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
        let audit_path = profile_dir.join("permissions").join("audit.sqlite");
        let audit_store = AuditStore::open(&audit_path).with_context(|| {
            format!("failed to open audit database at {}", audit_path.display())
        })?;

        Ok(Self {
            profile: ProfileView {
                id: profile.id.0,
                name: profile.name,
                active_agent_id: profile.active_agent_id,
            },
            profile_dir,
            openai_secret_ref,
            secret_store,
            policy_engine: PolicyEngine::default(),
            audit_store: Mutex::new(audit_store),
            browser_relay: Mutex::new(BrowserRelayState::default()),
        })
    }

    pub fn profile(&self) -> &ProfileView {
        &self.profile
    }

    pub fn list_agents(&self) -> Result<Vec<AgentView>> {
        self.agent_store().list()
    }

    pub fn get_agent(&self, id: &str) -> Result<AgentView> {
        self.agent_store().load(id)
    }

    pub fn save_agent(&self, request: SaveAgentRequest) -> Result<AgentView> {
        self.agent_store().save(request)
    }

    pub fn delete_agent(&self, id: &str) -> Result<()> {
        self.agent_store().delete(id)
    }

    pub fn list_workspaces(&self) -> Result<Vec<vulture_core::WorkspaceDefinition>> {
        self.workspace_store().list()
    }

    pub fn save_workspace(
        &self,
        request: SaveWorkspaceRequest,
    ) -> Result<vulture_core::WorkspaceDefinition> {
        self.workspace_store().save(request)
    }

    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        self.workspace_store().delete(id)
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

    pub fn decide_tool_request(&self, request: &ToolRequest) -> Result<PolicyDecision> {
        self.audit_store()?.append(
            "tool.requested",
            &json!({
                "runId": request.run_id,
                "tool": request.tool,
                "input": request.input,
            }),
        )?;

        let decision = self.policy_engine.decide(request);

        self.audit_store()?.append(
            "tool.policy_decision",
            &json!({
                "runId": request.run_id,
                "tool": request.tool,
                "decision": decision,
            }),
        )?;

        Ok(decision)
    }

    pub fn browser_status(&self) -> Result<BrowserRelayStatus> {
        Ok(self.browser_relay()?.status())
    }

    pub fn start_browser_pairing(&self) -> Result<BrowserRelayStatus> {
        self.browser_relay()?.enable_pairing(38421)
    }

    fn audit_store(&self) -> Result<MutexGuard<'_, AuditStore>> {
        self.audit_store
            .lock()
            .map_err(|_| anyhow!("audit store lock poisoned"))
    }

    fn browser_relay(&self) -> Result<MutexGuard<'_, BrowserRelayState>> {
        self.browser_relay
            .lock()
            .map_err(|_| anyhow!("browser relay lock poisoned"))
    }

    fn agent_store(&self) -> AgentStore {
        AgentStore::new(&self.profile_dir)
    }

    fn workspace_store(&self) -> WorkspaceStore {
        WorkspaceStore::new(&self.profile_dir)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::auth::{AuthSource, MemorySecretStore};

    use super::*;

    fn temp_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();

        std::env::temp_dir().join(format!(
            "vulture-desktop-state-test-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn new_for_root_creates_profile_json_and_audit_database() {
        let root = temp_root();

        let state = AppState::new_for_root(&root).expect("app state should initialize");

        assert_eq!(state.profile().id, "default");
        assert_eq!(state.profile().name, "Default");
        assert_eq!(state.profile().active_agent_id, "local-work-agent");
        assert!(root.join("profiles/default/profile.json").is_file());
        assert!(root
            .join("profiles/default/permissions/audit.sqlite")
            .is_file());

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

    #[test]
    fn persists_agents_and_workspaces_under_profile_dir() {
        let root = temp_root();
        let workspace_path = root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("workspace path should be created");
        let state =
            AppState::new_for_root_with_secret_store(&root, Box::new(MemorySecretStore::default()))
                .expect("app state should initialize");

        let agent = state
            .save_agent(SaveAgentRequest {
                id: "coder".to_string(),
                name: "Coder".to_string(),
                description: "Writes code".to_string(),
                model: "gpt-5.4".to_string(),
                reasoning: "medium".to_string(),
                tools: vec!["shell.exec".to_string()],
                instructions: "Write code carefully.".to_string(),
            })
            .expect("agent should save");
        let workspace = state
            .save_workspace(SaveWorkspaceRequest {
                id: "local".to_string(),
                name: "Local".to_string(),
                path: workspace_path.to_string_lossy().to_string(),
            })
            .expect("workspace should save");

        assert_eq!(
            state.get_agent(&agent.id).expect("agent should load").id,
            "coder"
        );
        assert_eq!(workspace.id, "local");
        assert_eq!(
            state
                .list_workspaces()
                .expect("workspaces should list")
                .len(),
            1
        );

        fs::remove_dir_all(root).expect("test root should be removable");
    }

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

        assert_eq!(missing.source, AuthSource::Missing);
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
