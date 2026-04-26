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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    pub active_agent_id: String,
}

pub struct AppState {
    profile: ProfileView,
    policy_engine: PolicyEngine,
    audit_store: Mutex<AuditStore>,
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
            policy_engine: PolicyEngine::default(),
            audit_store: Mutex::new(audit_store),
        })
    }

    pub fn profile(&self) -> &ProfileView {
        &self.profile
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

    fn audit_store(&self) -> Result<MutexGuard<'_, AuditStore>> {
        self.audit_store
            .lock()
            .map_err(|_| anyhow!("audit store lock poisoned"))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

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
}
