# Agent Command Center Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable command center: create/edit local agents, save workspaces, configure OpenAI API key storage, and run a real OpenAI Agents SDK agent from the desktop UI.

**Architecture:** Rust remains the authority for profile storage, Keychain access, workspace validation, sidecar process launch, and tool policy/audit. React uses Tauri commands only. The Bun sidecar receives an agent/workspace runtime snapshot from Rust and builds the OpenAI Agents SDK `Agent` from that snapshot.

**Tech Stack:** Tauri 2, Rust 2021, React 18, TypeScript 5, Bun, OpenAI Agents SDK, Zod, macOS Keychain through `keyring`.

---

## Scope

This plan implements a product-usable first command center. It includes:

- Profile-scoped agent definitions stored in `profiles/default/agents/<agent-id>/`.
- Profile-scoped workspace definitions stored in `profiles/default/workspaces/`.
- OpenAI auth status and API key storage through Rust and macOS Keychain.
- Real sidecar `run.create` execution with `OPENAI_API_KEY` injected into the child process environment.
- UI for agent creation/editing, workspace creation, OpenAI API key setup, and real runs.
- Automated tests that do not call OpenAI.

It does not include streaming UI, persisted conversations, multi-agent handoffs, ChatGPT OAuth, or an interactive tool approval response loop. Tool requests still flow through Rust policy/audit and receive the existing sidecar gateway stub result.

## File Structure

Create these files:

```text
crates/core/src/agent.rs
crates/core/src/workspace.rs
apps/desktop-shell/src/agent_store.rs
apps/desktop-shell/src/auth.rs
apps/desktop-shell/src/workspace_store.rs
apps/desktop-ui/src/commandCenterTypes.ts
docs/superpowers/reports/2026-04-26-agent-command-center-verification.md
```

Modify these files:

```text
crates/core/src/lib.rs
crates/core/src/storage.rs
packages/protocol/src/index.ts
packages/protocol/src/index.test.ts
apps/agent-sidecar/src/agents.ts
apps/agent-sidecar/src/agents.test.ts
apps/desktop-shell/src/state.rs
apps/desktop-shell/src/commands.rs
apps/desktop-shell/src/main.rs
apps/desktop-shell/src/sidecar.rs
apps/desktop-shell/Cargo.toml
apps/desktop-ui/src/App.tsx
apps/desktop-ui/src/styles.css
package.json
```

## Task 1: Runtime Snapshot Protocol

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/index.test.ts`

- [ ] **Step 1: Add failing protocol tests**

Add these tests to `packages/protocol/src/index.test.ts` inside `describe("protocol schemas", ...)`:

```ts
test("validates run.create with agent and workspace snapshots", () => {
  const parsed = RunCreateParams.parse({
    profileId: "default",
    workspaceId: "vulture",
    agentId: "local-work-agent",
    input: "summarize this repo",
    agent: {
      id: "local-work-agent",
      name: "Local Work Agent",
      instructions: "You are a local work agent.",
      model: "gpt-5.4",
      tools: ["shell.exec", "browser.snapshot", "browser.click"],
    },
    workspace: {
      id: "vulture",
      path: "/Users/johnny/Work/vulture",
    },
  });

  expect(parsed.agent?.tools).toEqual(["shell.exec", "browser.snapshot", "browser.click"]);
  expect(parsed.workspace?.path).toBe("/Users/johnny/Work/vulture");
});

test("rejects unsupported agent snapshot tools", () => {
  expect(() =>
    RunCreateParams.parse({
      profileId: "default",
      workspaceId: "vulture",
      agentId: "local-work-agent",
      input: "hello",
      agent: {
        id: "local-work-agent",
        name: "Local Work Agent",
        instructions: "You are a local work agent.",
        model: "gpt-5.4",
        tools: ["file.write"],
      },
      workspace: {
        id: "vulture",
        path: "/Users/johnny/Work/vulture",
      },
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run failing protocol tests**

Run:

```bash
bun test packages/protocol/src
```

Expected: the new tests fail because `RunCreateParams` does not accept `agent` or `workspace` snapshots yet.

- [ ] **Step 3: Implement protocol schemas**

In `packages/protocol/src/index.ts`, add these schemas above `RunCreateParams`:

```ts
export const AgentToolName = z.enum(["shell.exec", "browser.snapshot", "browser.click"]);

export const AgentRunConfig = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string().min(1),
  model: z.string().min(1),
  tools: z.array(AgentToolName).default([]),
});

export const WorkspaceRunConfig = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
});
```

Replace `RunCreateParams` with:

```ts
export const RunCreateParams = z.object({
  profileId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.string().min(1),
  agent: AgentRunConfig.optional(),
  workspace: WorkspaceRunConfig.optional(),
});
```

The snapshots are optional so the existing mock tests remain valid until Rust starts sending them for real runs.

- [ ] **Step 4: Verify and commit**

Run:

```bash
bun test packages/protocol/src
bun --filter @vulture/protocol typecheck
```

Expected: protocol tests and typecheck pass.

Commit:

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git commit -m "feat: add agent run snapshots to protocol"
```

## Task 2: Core Agent And Workspace Domain

**Files:**
- Create: `crates/core/src/agent.rs`
- Create: `crates/core/src/workspace.rs`
- Modify: `crates/core/src/lib.rs`
- Modify: `crates/core/src/storage.rs`

- [ ] **Step 1: Add core domain modules and tests**

Create `crates/core/src/agent.rs`:

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: String,
    pub reasoning: String,
    pub tools: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRecord {
    pub definition: AgentDefinition,
    pub instructions: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AgentValidationError {
    #[error("agent id must be a lowercase slug")]
    InvalidId,
    #[error("agent name must not be empty")]
    EmptyName,
    #[error("agent model must not be empty")]
    EmptyModel,
    #[error("agent instructions must not be empty")]
    EmptyInstructions,
    #[error("unsupported agent tool {0}")]
    UnsupportedTool(String),
}

pub const SUPPORTED_AGENT_TOOLS: &[&str] = &["shell.exec", "browser.snapshot", "browser.click"];

impl AgentRecord {
    pub fn default_local_work_agent(now: DateTime<Utc>) -> Self {
        Self {
            definition: AgentDefinition {
                id: "local-work-agent".to_string(),
                name: "Local Work Agent".to_string(),
                description: "General local work assistant".to_string(),
                model: "gpt-5.4".to_string(),
                reasoning: "medium".to_string(),
                tools: SUPPORTED_AGENT_TOOLS.iter().map(|tool| (*tool).to_string()).collect(),
                created_at: now,
                updated_at: now,
            },
            instructions:
                "You are Vulture's local work agent. Request local actions through tools and never claim a local command ran unless a tool result confirms it."
                    .to_string(),
        }
    }

    pub fn validate(&self) -> Result<(), AgentValidationError> {
        if !is_slug(&self.definition.id) {
            return Err(AgentValidationError::InvalidId);
        }
        if self.definition.name.trim().is_empty() {
            return Err(AgentValidationError::EmptyName);
        }
        if self.definition.model.trim().is_empty() {
            return Err(AgentValidationError::EmptyModel);
        }
        if self.instructions.trim().is_empty() {
            return Err(AgentValidationError::EmptyInstructions);
        }
        for tool in &self.definition.tools {
            if !SUPPORTED_AGENT_TOOLS.contains(&tool.as_str()) {
                return Err(AgentValidationError::UnsupportedTool(tool.clone()));
            }
        }
        Ok(())
    }
}

pub fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_agent_is_valid() {
        let agent = AgentRecord::default_local_work_agent(Utc::now());
        agent.validate().expect("default agent should be valid");
        assert_eq!(agent.definition.id, "local-work-agent");
        assert!(agent.definition.tools.contains(&"shell.exec".to_string()));
    }

    #[test]
    fn rejects_unsupported_tools() {
        let mut agent = AgentRecord::default_local_work_agent(Utc::now());
        agent.definition.tools = vec!["file.write".to_string()];
        assert_eq!(
            agent.validate(),
            Err(AgentValidationError::UnsupportedTool("file.write".to_string()))
        );
    }

    #[test]
    fn validates_slug_ids() {
        assert!(is_slug("browser-researcher"));
        assert!(!is_slug("Browser Researcher"));
        assert!(!is_slug("-browser"));
        assert!(!is_slug("browser-"));
    }
}
```

Create `crates/core/src/workspace.rs`:

```rust
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::agent::is_slug;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDefinition {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkspaceValidationError {
    #[error("workspace id must be a lowercase slug")]
    InvalidId,
    #[error("workspace name must not be empty")]
    EmptyName,
    #[error("workspace path must be an existing directory")]
    MissingDirectory,
}

impl WorkspaceDefinition {
    pub fn new(id: String, name: String, path: String, now: DateTime<Utc>) -> Self {
        Self {
            id,
            name,
            path,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn validate(&self) -> Result<(), WorkspaceValidationError> {
        if !is_slug(&self.id) {
            return Err(WorkspaceValidationError::InvalidId);
        }
        if self.name.trim().is_empty() {
            return Err(WorkspaceValidationError::EmptyName);
        }
        if !Path::new(&self.path).is_dir() {
            return Err(WorkspaceValidationError::MissingDirectory);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_existing_workspace_path() {
        let workspace = WorkspaceDefinition::new(
            "tmp".to_string(),
            "Temp".to_string(),
            std::env::temp_dir().to_string_lossy().to_string(),
            Utc::now(),
        );
        workspace.validate().expect("temp dir should be valid");
    }

    #[test]
    fn rejects_missing_workspace_path() {
        let workspace = WorkspaceDefinition::new(
            "missing".to_string(),
            "Missing".to_string(),
            "/path/that/does/not/exist".to_string(),
            Utc::now(),
        );
        assert_eq!(
            workspace.validate(),
            Err(WorkspaceValidationError::MissingDirectory)
        );
    }
}
```

- [ ] **Step 2: Wire modules and storage directories**

Modify `crates/core/src/lib.rs`:

```rust
pub mod agent;
pub mod error;
pub mod paths;
pub mod profile;
pub mod storage;
pub mod workspace;

pub use agent::{AgentDefinition, AgentRecord, SUPPORTED_AGENT_TOOLS};
pub use error::{CoreError, CoreResult};
pub use paths::AppPaths;
pub use profile::{Profile, ProfileId};
pub use storage::StorageLayout;
pub use workspace::WorkspaceDefinition;
```

Modify `crates/core/src/storage.rs` so `ensure_profile` creates `workspaces` too:

```rust
fs::create_dir_all(dir.join("agents"))?;
fs::create_dir_all(dir.join("conversations"))?;
fs::create_dir_all(dir.join("permissions"))?;
fs::create_dir_all(dir.join("workspaces"))?;
```

Update the existing storage test to assert the new directory:

```rust
assert!(dir.join("workspaces").is_dir());
```

- [ ] **Step 3: Verify and commit**

Run:

```bash
cargo test -p vulture-core agent
cargo test -p vulture-core workspace
cargo test -p vulture-core storage
cargo clippy -p vulture-core -- -D warnings
```

Expected: tests and clippy pass.

Commit:

```bash
git add crates/core/src/agent.rs crates/core/src/workspace.rs crates/core/src/lib.rs crates/core/src/storage.rs
git commit -m "feat: add agent and workspace domain"
```

## Task 3: Desktop Stores And Auth Boundary

**Files:**
- Create: `apps/desktop-shell/src/agent_store.rs`
- Create: `apps/desktop-shell/src/workspace_store.rs`
- Create: `apps/desktop-shell/src/auth.rs`
- Modify: `apps/desktop-shell/src/state.rs`
- Modify: `apps/desktop-shell/src/commands.rs`
- Modify: `apps/desktop-shell/src/main.rs`
- Modify: `apps/desktop-shell/Cargo.toml`

- [ ] **Step 1: Add agent store**

Create `apps/desktop-shell/src/agent_store.rs`:

```rust
use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::Serialize;
use vulture_core::{AgentDefinition, AgentRecord};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: String,
    pub reasoning: String,
    pub tools: Vec<String>,
    pub instructions: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAgentRequest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: String,
    pub reasoning: String,
    pub tools: Vec<String>,
    pub instructions: String,
}

#[derive(Debug, Clone)]
pub struct AgentStore {
    root: PathBuf,
}

impl AgentStore {
    pub fn new(profile_dir: impl AsRef<Path>) -> Self {
        Self {
            root: profile_dir.as_ref().join("agents"),
        }
    }

    pub fn ensure_default_agent(&self) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        let path = self.root.join("local-work-agent");
        if !path.join("agent.json").exists() {
            self.save_record(&AgentRecord::default_local_work_agent(Utc::now()))?;
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<AgentView>> {
        self.ensure_default_agent()?;
        let mut agents = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                agents.push(self.load(entry.file_name().to_string_lossy().as_ref())?);
            }
        }
        agents.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(agents)
    }

    pub fn load(&self, id: &str) -> Result<AgentView> {
        let dir = self.root.join(id);
        let definition: AgentDefinition = serde_json::from_str(
            &fs::read_to_string(dir.join("agent.json"))
                .with_context(|| format!("failed to read agent {id}"))?,
        )?;
        let instructions = fs::read_to_string(dir.join("instructions.md"))
            .with_context(|| format!("failed to read instructions for agent {id}"))?;
        Ok(AgentView {
            id: definition.id,
            name: definition.name,
            description: definition.description,
            model: definition.model,
            reasoning: definition.reasoning,
            tools: definition.tools,
            instructions,
        })
    }

    pub fn save(&self, request: SaveAgentRequest) -> Result<AgentView> {
        let now = Utc::now();
        let existing = self.load(&request.id).ok();
        let record = AgentRecord {
            definition: AgentDefinition {
                id: request.id.clone(),
                name: request.name,
                description: request.description,
                model: request.model,
                reasoning: request.reasoning,
                tools: request.tools,
                created_at: existing
                    .as_ref()
                    .and_then(|agent| {
                        let path = self.root.join(&agent.id).join("agent.json");
                        serde_json::from_str::<AgentDefinition>(&fs::read_to_string(path).ok()?)
                            .ok()
                            .map(|definition| definition.created_at)
                    })
                    .unwrap_or(now),
                updated_at: now,
            },
            instructions: request.instructions,
        };
        record.validate()?;
        self.save_record(&record)?;
        self.load(&record.definition.id)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let agents = self.list()?;
        if agents.len() <= 1 {
            return Err(anyhow!("cannot delete the last agent"));
        }
        fs::remove_dir_all(self.root.join(id))?;
        Ok(())
    }

    fn save_record(&self, record: &AgentRecord) -> Result<()> {
        record.validate()?;
        let dir = self.root.join(&record.definition.id);
        fs::create_dir_all(&dir)?;
        fs::write(
            dir.join("agent.json"),
            serde_json::to_string_pretty(&record.definition)?,
        )?;
        fs::write(dir.join("instructions.md"), &record.instructions)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temp_profile_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("vulture-agent-store-test-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn creates_default_agent() {
        let root = temp_profile_dir();
        let store = AgentStore::new(&root);
        let agents = store.list().expect("agents should list");
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "local-work-agent");
        fs::remove_dir_all(root).expect("temp root should be removed");
    }

    #[test]
    fn saves_and_reloads_agent_instructions() {
        let root = temp_profile_dir();
        let store = AgentStore::new(&root);
        let saved = store
            .save(SaveAgentRequest {
                id: "coder".to_string(),
                name: "Coder".to_string(),
                description: "Writes code".to_string(),
                model: "gpt-5.4".to_string(),
                reasoning: "medium".to_string(),
                tools: vec!["shell.exec".to_string()],
                instructions: "Write code carefully.".to_string(),
            })
            .expect("agent should save");
        let loaded = store.load(&saved.id).expect("agent should load");
        assert_eq!(loaded.instructions, "Write code carefully.");
        fs::remove_dir_all(root).expect("temp root should be removed");
    }
}
```

- [ ] **Step 2: Add workspace store**

Create `apps/desktop-shell/src/workspace_store.rs`:

```rust
use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::Result;
use chrono::Utc;
use serde::Deserialize;
use vulture_core::WorkspaceDefinition;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceRequest {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceStore {
    root: PathBuf,
}

impl WorkspaceStore {
    pub fn new(profile_dir: impl AsRef<Path>) -> Self {
        Self {
            root: profile_dir.as_ref().join("workspaces"),
        }
    }

    pub fn list(&self) -> Result<Vec<WorkspaceDefinition>> {
        fs::create_dir_all(&self.root)?;
        let mut workspaces = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                workspaces.push(serde_json::from_str(&fs::read_to_string(entry.path())?)?);
            }
        }
        workspaces.sort_by(|left: &WorkspaceDefinition, right| left.name.cmp(&right.name));
        Ok(workspaces)
    }

    pub fn save(&self, request: SaveWorkspaceRequest) -> Result<WorkspaceDefinition> {
        fs::create_dir_all(&self.root)?;
        let now = Utc::now();
        let path = PathBuf::from(&request.path)
            .canonicalize()
            .map_err(|_| vulture_core::workspace::WorkspaceValidationError::MissingDirectory)?;
        let workspace = WorkspaceDefinition::new(
            request.id,
            request.name,
            path.to_string_lossy().to_string(),
            now,
        );
        workspace.validate()?;
        fs::write(
            self.root.join(format!("{}.json", workspace.id)),
            serde_json::to_string_pretty(&workspace)?,
        )?;
        Ok(workspace)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let path = self.root.join(format!("{id}.json"));
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}
```

- [ ] **Step 3: Add auth boundary**

Create `apps/desktop-shell/src/auth.rs`:

```rust
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

pub fn auth_status(secret_store: &dyn SecretStore, secret_ref: &str) -> Result<OpenAiAuthStatus> {
    if secret_store.get(secret_ref)?.is_some() {
        return Ok(OpenAiAuthStatus {
            configured: true,
            source: AuthSource::Keychain,
        });
    }

    if std::env::var_os("OPENAI_API_KEY").is_some() {
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
    if let Some(value) = secret_store.get(secret_ref)? {
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }

    if let Ok(value) = std::env::var("OPENAI_API_KEY") {
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }

    Err(anyhow!("OpenAI API key required."))
}
```

- [ ] **Step 4: Wire AppState and commands**

Modify `apps/desktop-shell/Cargo.toml` dependencies:

```toml
chrono.workspace = true
keyring.workspace = true
```

Modify `apps/desktop-shell/src/main.rs`:

```rust
mod agent_store;
mod auth;
mod browser;
mod commands;
mod sidecar;
mod state;
mod workspace_store;
```

Register commands:

```rust
commands::list_agents,
commands::get_agent,
commands::save_agent,
commands::delete_agent,
commands::list_workspaces,
commands::save_workspace,
commands::delete_workspace,
commands::get_openai_auth_status,
commands::set_openai_api_key,
commands::clear_openai_api_key,
```

Modify `apps/desktop-shell/src/state.rs`:

- Add fields:

```rust
profile_dir: PathBuf,
secret_store: Box<dyn crate::auth::SecretStore>,
openai_secret_ref: String,
```

- In `new_for_root`, set:

```rust
profile_dir: profile_dir.clone(),
secret_store: Box::<crate::auth::KeychainSecretStore>::default(),
openai_secret_ref: profile.openai_secret_ref.clone(),
```

- Add methods:

```rust
pub fn list_agents(&self) -> Result<Vec<crate::agent_store::AgentView>> {
    crate::agent_store::AgentStore::new(&self.profile_dir).list()
}

pub fn get_agent(&self, id: &str) -> Result<crate::agent_store::AgentView> {
    crate::agent_store::AgentStore::new(&self.profile_dir).load(id)
}

pub fn save_agent(
    &self,
    request: crate::agent_store::SaveAgentRequest,
) -> Result<crate::agent_store::AgentView> {
    crate::agent_store::AgentStore::new(&self.profile_dir).save(request)
}

pub fn delete_agent(&self, id: &str) -> Result<()> {
    crate::agent_store::AgentStore::new(&self.profile_dir).delete(id)
}

pub fn list_workspaces(&self) -> Result<Vec<vulture_core::WorkspaceDefinition>> {
    crate::workspace_store::WorkspaceStore::new(&self.profile_dir).list()
}

pub fn save_workspace(
    &self,
    request: crate::workspace_store::SaveWorkspaceRequest,
) -> Result<vulture_core::WorkspaceDefinition> {
    crate::workspace_store::WorkspaceStore::new(&self.profile_dir).save(request)
}

pub fn delete_workspace(&self, id: &str) -> Result<()> {
    crate::workspace_store::WorkspaceStore::new(&self.profile_dir).delete(id)
}

pub fn openai_auth_status(&self) -> Result<crate::auth::OpenAiAuthStatus> {
    crate::auth::auth_status(self.secret_store.as_ref(), &self.openai_secret_ref)
}

pub fn set_openai_api_key(&self, api_key: &str) -> Result<crate::auth::OpenAiAuthStatus> {
    self.secret_store.set(&self.openai_secret_ref, api_key)?;
    self.openai_auth_status()
}

pub fn clear_openai_api_key(&self) -> Result<crate::auth::OpenAiAuthStatus> {
    self.secret_store.clear(&self.openai_secret_ref)?;
    self.openai_auth_status()
}
```

Modify `apps/desktop-shell/src/commands.rs` by adding Tauri command wrappers that call these methods and map errors with `error.to_string()`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cargo test -p vulture-desktop-shell agent_store
cargo test -p vulture-desktop-shell workspace_store
cargo test -p vulture-desktop-shell auth
cargo test -p vulture-desktop-shell state
cargo check -p vulture-desktop-shell
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings
```

Expected: tests/check/clippy pass.

Commit:

```bash
git add apps/desktop-shell/Cargo.toml apps/desktop-shell/src/agent_store.rs apps/desktop-shell/src/workspace_store.rs apps/desktop-shell/src/auth.rs apps/desktop-shell/src/state.rs apps/desktop-shell/src/commands.rs apps/desktop-shell/src/main.rs
git commit -m "feat: add command center stores and auth"
```

## Task 4: Sidecar Real Agent Runtime

**Files:**
- Modify: `apps/agent-sidecar/src/agents.ts`
- Modify: `apps/agent-sidecar/src/agents.test.ts`

- [ ] **Step 1: Add sidecar runtime tests**

In `apps/agent-sidecar/src/agents.test.ts`, add:

```ts
import type { Agent } from "@openai/agents";
```

Add tests:

```ts
test("real run builds tools from agent snapshot", async () => {
  const seenTools: string[][] = [];
  const events = await runAgent(
    {
      profileId: "default",
      workspaceId: "vulture",
      agentId: "coder",
      input: "hello",
      agent: {
        id: "coder",
        name: "Coder",
        instructions: "Write code.",
        model: "gpt-5.4",
        tools: ["shell.exec"],
      },
      workspace: { id: "vulture", path: "/tmp" },
    },
    () => ({
      request: async () => ({ ok: true }),
    }),
    {
      runModel: async (agent: Agent, input: string) => {
        seenTools.push(agent.tools.map((tool) => tool.name));
        return { finalOutput: `ran:${input}` };
      },
    },
  );

  expect(seenTools).toEqual([["shell_exec"]]);
  expect(events.at(-1)?.payload).toEqual({ finalOutput: "ran:hello" });
});

test("real run uses default local work agent when snapshot is absent", async () => {
  const seenTools: string[][] = [];
  await runAgent(
    validRunParams,
    () => ({
      request: async () => ({ ok: true }),
    }),
    {
      runModel: async (agent: Agent) => {
        seenTools.push(agent.tools.map((tool) => tool.name));
        return { finalOutput: "ok" };
      },
    },
  );

  expect(seenTools).toEqual([["shell_exec", "browser_snapshot", "browser_click"]]);
});
```

- [ ] **Step 2: Run failing sidecar tests**

Run:

```bash
bun test apps/agent-sidecar/src/agents.test.ts
```

Expected: tests fail because `runAgent` does not accept injected `runModel` options and ignores snapshots.

- [ ] **Step 3: Implement snapshot-based agent creation**

Modify `apps/agent-sidecar/src/agents.ts`:

```ts
import { Agent, run } from "@openai/agents";
import { AgentRunConfig, makeEvent, RunCreateParams } from "@vulture/protocol";
import { createBrowserTools, createShellExecTool, type ToolGateway } from "./tools";

export type GatewayFactory = (runId: string) => ToolGateway;
export type RunModel = (agent: Agent, input: string) => Promise<{ finalOutput?: unknown }>;

export type RunAgentOptions = {
  runModel?: RunModel;
};

export function createAgentFromConfig(config: unknown, gateway: ToolGateway) {
  const parsed = AgentRunConfig.parse(config);
  const browserTools = createBrowserTools(gateway);
  const tools = [];

  if (parsed.tools.includes("shell.exec")) tools.push(createShellExecTool(gateway));
  if (parsed.tools.includes("browser.snapshot")) tools.push(browserTools.snapshot);
  if (parsed.tools.includes("browser.click")) tools.push(browserTools.click);

  return new Agent({
    name: parsed.id,
    instructions: parsed.instructions,
    model: parsed.model,
    tools,
  });
}

export function createLocalWorkAgent(gateway: ToolGateway) {
  return createAgentFromConfig(
    {
      id: "local-work-agent",
      name: "Local Work Agent",
      instructions:
        "You are Vulture's local work agent. Request local actions through tools and never claim a local command ran unless a tool result confirms it.",
      model: "gpt-5.4",
      tools: ["shell.exec", "browser.snapshot", "browser.click"],
    },
    gateway,
  );
}

export async function runAgent(
  params: unknown,
  createGateway: GatewayFactory,
  options: RunAgentOptions = {},
) {
  const parsed = RunCreateParams.parse(params);
  const runId = `run_${Date.now()}`;
  const gateway = createGateway(runId);
  const runModel = options.runModel ?? ((agent, input) => run(agent, input));

  if (process.env.VULTURE_AGENT_MODE === "mock") {
    if (process.env.VULTURE_MOCK_TOOL_REQUEST === "1") {
      await gateway.request("shell.exec", {
        cwd: "/tmp",
        argv: ["pwd"],
        timeoutMs: 120000,
      });
    }

    return [
      makeEvent(runId, "run_started", { agentId: parsed.agentId }),
      makeEvent(runId, "model_delta", { text: `Mock response for: ${parsed.input}` }),
      makeEvent(runId, "run_completed", { finalOutput: "Mock run completed" }),
    ];
  }

  const agent = parsed.agent
    ? createAgentFromConfig(parsed.agent, gateway)
    : createLocalWorkAgent(gateway);
  const result = await runModel(agent, parsed.input);

  return [
    makeEvent(runId, "run_started", { agentId: parsed.agentId }),
    makeEvent(runId, "run_completed", {
      finalOutput: result.finalOutput ? String(result.finalOutput) : "",
    }),
  ];
}
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
bun test apps/agent-sidecar/src
bun --filter @vulture/agent-sidecar typecheck
```

Expected: tests and typecheck pass without calling OpenAI.

Commit:

```bash
git add apps/agent-sidecar/src/agents.ts apps/agent-sidecar/src/agents.test.ts
git commit -m "feat: build sidecar agents from snapshots"
```

## Task 5: Rust Real Run Command

**Files:**
- Modify: `apps/desktop-shell/src/sidecar.rs`
- Modify: `apps/desktop-shell/src/state.rs`
- Modify: `apps/desktop-shell/src/commands.rs`
- Modify: `apps/desktop-shell/src/main.rs`

- [ ] **Step 1: Add missing-auth and snapshot tests**

In `apps/desktop-shell/src/sidecar.rs`, add tests that build a `run.create` request payload without launching OpenAI:

```rust
#[test]
fn agent_run_request_contains_agent_and_workspace_snapshots() {
    let agent = crate::agent_store::AgentView {
        id: "coder".to_string(),
        name: "Coder".to_string(),
        description: "Writes code".to_string(),
        model: "gpt-5.4".to_string(),
        reasoning: "medium".to_string(),
        tools: vec!["shell.exec".to_string()],
        instructions: "Write code carefully.".to_string(),
    };
    let workspace = vulture_core::WorkspaceDefinition::new(
        "vulture".to_string(),
        "Vulture".to_string(),
        "/tmp".to_string(),
        chrono::Utc::now(),
    );

    let request = run_create_request("run-real", "hello", &agent, &workspace);

    assert_eq!(request["method"], "run.create");
    assert_eq!(request["params"]["agent"]["id"], "coder");
    assert_eq!(request["params"]["agent"]["tools"], serde_json::json!(["shell.exec"]));
    assert_eq!(request["params"]["workspace"]["path"], "/tmp");
}
```

In `apps/desktop-shell/src/state.rs`, add a unit test using a memory secret store:

```rust
#[test]
fn openai_auth_status_reports_missing_without_secret_or_environment() {
    let root = temp_root();
    let state = AppState::new_for_root_with_secret_store(&root, Box::new(crate::auth::MemorySecretStore::default()))
        .expect("app state should initialize");

    let status = state.openai_auth_status().expect("status should resolve");

    assert!(!status.configured);
    assert_eq!(format!("{:?}", status.source), "Missing");
    fs::remove_dir_all(root).expect("test root should be removable");
}
```

- [ ] **Step 2: Implement testable secret store**

Extend `apps/desktop-shell/src/auth.rs` with a test-friendly store:

```rust
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    value: std::sync::Mutex<Option<String>>,
}

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
```

Add `use anyhow::anyhow;` if needed.

- [ ] **Step 3: Add real run sidecar function**

In `apps/desktop-shell/src/sidecar.rs`, add:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentRunRequest {
    pub agent_id: String,
    pub workspace_id: String,
    pub input: String,
}

pub async fn start_agent_run(
    request: StartAgentRunRequest,
    state: &AppState,
) -> Result<Vec<Value>> {
    let api_key = state.resolve_openai_api_key()?;
    let agent = state.get_agent(&request.agent_id)?;
    let workspace = state
        .list_workspaces()?
        .into_iter()
        .find(|workspace| workspace.id == request.workspace_id)
        .ok_or_else(|| anyhow!("workspace {} was not found", request.workspace_id))?;

    run_sidecar(
        run_create_request("desktop-agent-run", &request.input, &agent, &workspace),
        Some(api_key),
        state,
    )
    .await
}

fn run_create_request(
    id: &str,
    input: &str,
    agent: &crate::agent_store::AgentView,
    workspace: &vulture_core::WorkspaceDefinition,
) -> Value {
    json!({
        "id": id,
        "method": "run.create",
        "params": {
            "profileId": "default",
            "workspaceId": workspace.id,
            "agentId": agent.id,
            "input": input,
            "agent": {
                "id": agent.id,
                "name": agent.name,
                "instructions": agent.instructions,
                "model": agent.model,
                "tools": agent.tools,
            },
            "workspace": {
                "id": workspace.id,
                "path": workspace.path,
            }
        }
    })
}
```

Refactor existing `start_mock_run` process launch into:

```rust
async fn run_sidecar(request: Value, openai_api_key: Option<String>, state: &AppState) -> Result<Vec<Value>> {
    let repo_root = repo_root();
    let sidecar_path = repo_root.join("apps/agent-sidecar/src/main.ts");
    let mut command = Command::new("bun");
    command
        .arg(&sidecar_path)
        .current_dir(&repo_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(api_key) = openai_api_key {
        command.env("OPENAI_API_KEY", api_key);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start sidecar at {}", sidecar_path.display()))?;
    // keep the existing stdin/stdout/stderr handling
}
```

Keep `start_mock_run` by calling `run_sidecar` with mock env setup or retain the old function body for mock tests. Do not remove mock support because `bun run verify` uses it.

- [ ] **Step 4: Wire AppState and command**

Add to `apps/desktop-shell/src/state.rs`:

```rust
pub fn resolve_openai_api_key(&self) -> Result<String> {
    crate::auth::resolve_openai_api_key(self.secret_store.as_ref(), &self.openai_secret_ref)
}
```

Add command in `apps/desktop-shell/src/commands.rs`:

```rust
#[tauri::command]
pub async fn start_agent_run(
    state: State<'_, AppState>,
    request: crate::sidecar::StartAgentRunRequest,
) -> Result<Vec<Value>, String> {
    sidecar::start_agent_run(request, state.inner())
        .await
        .map_err(|error| error.to_string())
}
```

Register `commands::start_agent_run` in `apps/desktop-shell/src/main.rs`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cargo test -p vulture-desktop-shell sidecar
cargo test -p vulture-desktop-shell state
cargo test -p vulture-desktop-shell auth
cargo check -p vulture-desktop-shell
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings
```

Expected: tests/check/clippy pass. No test calls OpenAI.

Commit:

```bash
git add apps/desktop-shell/src/sidecar.rs apps/desktop-shell/src/state.rs apps/desktop-shell/src/commands.rs apps/desktop-shell/src/main.rs apps/desktop-shell/src/auth.rs
git commit -m "feat: add real agent run command"
```

## Task 6: Command Center UI

**Files:**
- Create: `apps/desktop-ui/src/commandCenterTypes.ts`
- Modify: `apps/desktop-ui/src/App.tsx`
- Modify: `apps/desktop-ui/src/styles.css`

- [ ] **Step 1: Add UI types**

Create `apps/desktop-ui/src/commandCenterTypes.ts`:

```ts
export type AgentView = {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: string;
  tools: string[];
  instructions: string;
};

export type WorkspaceView = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenAiAuthStatus = {
  configured: boolean;
  source: "keychain" | "environment" | "missing";
};

export type SaveAgentRequest = AgentView;

export type SaveWorkspaceRequest = {
  id: string;
  name: string;
  path: string;
};
```

- [ ] **Step 2: Replace fixed UI with command center state**

In `apps/desktop-ui/src/App.tsx`, add imports:

```ts
import type {
  AgentView,
  OpenAiAuthStatus,
  SaveWorkspaceRequest,
  WorkspaceView,
} from "./commandCenterTypes";
```

Add state:

```ts
const [agents, setAgents] = useState<AgentView[]>([]);
const [selectedAgentId, setSelectedAgentId] = useState("");
const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
const [authStatus, setAuthStatus] = useState<OpenAiAuthStatus | null>(null);
const [apiKeyInput, setApiKeyInput] = useState("");
const [workspaceDraft, setWorkspaceDraft] = useState<SaveWorkspaceRequest>({
  id: "vulture",
  name: "Vulture",
  path: "/Users/johnny/Work/vulture",
});
const [taskInput, setTaskInput] = useState("Summarize this workspace");
```

Add load helpers:

```ts
async function loadCommandCenter() {
  const [agentList, workspaceList, nextAuthStatus] = await Promise.all([
    invoke<AgentView[]>("list_agents"),
    invoke<WorkspaceView[]>("list_workspaces"),
    invoke<OpenAiAuthStatus>("get_openai_auth_status"),
  ]);
  setAgents(agentList);
  setWorkspaces(workspaceList);
  setAuthStatus(nextAuthStatus);
  setSelectedAgentId((current) => current || agentList[0]?.id || "");
  setSelectedWorkspaceId((current) => current || workspaceList[0]?.id || "");
}
```

Call `loadCommandCenter()` from the existing `useEffect`.

- [ ] **Step 3: Add save and run actions**

Add these functions to `App.tsx`:

```ts
async function saveSelectedAgent(nextAgent: AgentView) {
  setError(null);
  try {
    const saved = await invoke<AgentView>("save_agent", { request: nextAgent });
    setAgents((current) => {
      const rest = current.filter((agent) => agent.id !== saved.id);
      return [...rest, saved].sort((left, right) => left.name.localeCompare(right.name));
    });
    setSelectedAgentId(saved.id);
  } catch (cause) {
    setError(errorMessage(cause));
  }
}

async function createAgentFromTemplate(template: "local" | "coder" | "browser") {
  const templates: Record<typeof template, AgentView> = {
    local: {
      id: "local-work-agent",
      name: "Local Work Agent",
      description: "General local work assistant",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["shell.exec", "browser.snapshot", "browser.click"],
      instructions:
        "You are Vulture's local work agent. Request local actions through tools and never claim a local command ran unless a tool result confirms it.",
    },
    coder: {
      id: "coder",
      name: "Coder",
      description: "Focused coding assistant",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["shell.exec"],
      instructions: "You are a careful coding agent. Explain changes briefly and verify them.",
    },
    browser: {
      id: "browser-researcher",
      name: "Browser Researcher",
      description: "Research assistant using browser tools",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["browser.snapshot", "browser.click"],
      instructions: "You inspect browser context and summarize findings clearly.",
    },
  };
  await saveSelectedAgent(templates[template]);
}

async function saveWorkspace() {
  setError(null);
  try {
    const saved = await invoke<WorkspaceView>("save_workspace", { request: workspaceDraft });
    setWorkspaces((current) => {
      const rest = current.filter((workspace) => workspace.id !== saved.id);
      return [...rest, saved].sort((left, right) => left.name.localeCompare(right.name));
    });
    setSelectedWorkspaceId(saved.id);
  } catch (cause) {
    setError(errorMessage(cause));
  }
}

async function saveApiKey() {
  setError(null);
  try {
    const result = await invoke<OpenAiAuthStatus>("set_openai_api_key", {
      request: { apiKey: apiKeyInput },
    });
    setAuthStatus(result);
    setApiKeyInput("");
  } catch (cause) {
    setError(errorMessage(cause));
  }
}

async function startRealRun() {
  if (isRunning.current) return;
  isRunning.current = true;
  setStatus("running");
  setError(null);
  try {
    const result = await invoke<RunEvent[]>("start_agent_run", {
      request: {
        agentId: selectedAgentId,
        workspaceId: selectedWorkspaceId,
        input: taskInput,
      },
    });
    setEvents(result);
    setStatus("completed");
  } catch (cause) {
    setStatus("failed");
    setError(errorMessage(cause));
  } finally {
    isRunning.current = false;
  }
}
```

- [ ] **Step 4: Render usable command center**

Replace the existing main JSX with a functional three-column layout:

```tsx
const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
const canRun =
  Boolean(selectedAgent && selectedWorkspace && taskInput.trim() && authStatus?.configured) &&
  status !== "running";
```

Render:

```tsx
<aside className="sidebar">
  <h1>Vulture</h1>
  <button type="button">{profile?.name ?? "Default Profile"}</button>
  <h2>Agents</h2>
  {agents.map((agent) => (
    <button type="button" key={agent.id} onClick={() => setSelectedAgentId(agent.id)}>
      {agent.name}
    </button>
  ))}
  <button type="button" onClick={() => createAgentFromTemplate("coder")}>Create Coder</button>
  <button type="button" onClick={() => createAgentFromTemplate("browser")}>Create Browser Researcher</button>
  <h2>Workspaces</h2>
  {workspaces.map((workspace) => (
    <button type="button" key={workspace.id} onClick={() => setSelectedWorkspaceId(workspace.id)}>
      {workspace.name}
    </button>
  ))}
</aside>
<main className="workspace">
  <header>
    <div>
      <p className="eyebrow">Command Center</p>
      <h2>Run Agent</h2>
    </div>
    <button type="button" onClick={startRealRun} disabled={!canRun}>Run</button>
  </header>
  <section className="timeline">
    <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
      {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
    </select>
    <select value={selectedWorkspaceId} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
      {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select>
    <textarea value={taskInput} onChange={(event) => setTaskInput(event.target.value)} />
    <p className="status">Run state: {status}</p>
    {error ? <p className="error">{error}</p> : null}
    {events.map((event, index) => (
      <article key={`${event.type}-${index}`} className="event">
        <strong>{event.type}</strong>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </article>
    ))}
  </section>
</main>
```

Render right inspector with selected agent fields, tool checkboxes, auth setup, workspace draft, and existing Browser pairing panel. Keep controls simple and dense; avoid decorative layout changes.

- [ ] **Step 5: Add minimal styles**

Add to `apps/desktop-ui/src/styles.css`:

```css
input, select, textarea {
  border: 1px solid #c9d3dc;
  border-radius: 6px;
  background: #ffffff;
  color: #162027;
  font: inherit;
  padding: 8px 10px;
  width: 100%;
}
textarea {
  min-height: 110px;
  resize: vertical;
}
.field {
  display: grid;
  gap: 6px;
  margin: 10px 0;
}
.field label {
  color: #65727d;
  font-size: 12px;
}
.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.tool-row input {
  width: auto;
}
```

- [ ] **Step 6: Verify and commit**

Run:

```bash
bun --filter @vulture/desktop-ui typecheck
bun --filter @vulture/desktop-ui build
```

Expected: typecheck and build pass.

Commit:

```bash
git add apps/desktop-ui/src/commandCenterTypes.ts apps/desktop-ui/src/App.tsx apps/desktop-ui/src/styles.css
git commit -m "feat: add command center UI"
```

## Task 7: Verification Script And Report

**Files:**
- Modify: `package.json`
- Create: `docs/superpowers/reports/2026-04-26-agent-command-center-verification.md`

- [ ] **Step 1: Add verification script**

Modify root `package.json` scripts:

```json
"verify:command-center": "bun test packages/protocol/src apps/agent-sidecar/src && bun --filter '*' typecheck && bun --filter @vulture/desktop-ui build && cargo test -p vulture-core agent && cargo test -p vulture-core workspace && cargo test -p vulture-core storage && cargo test -p vulture-desktop-shell agent_store && cargo test -p vulture-desktop-shell workspace_store && cargo test -p vulture-desktop-shell auth && cargo test -p vulture-desktop-shell sidecar && cargo test -p vulture-desktop-shell state && cargo clippy --workspace --all-targets -- -D warnings"
```

- [ ] **Step 2: Run verification**

Run:

```bash
bun run verify:command-center
bun run verify
git status --short
```

Expected: both verification commands pass. `git status --short` shows only intended `package.json` and report changes before the report commit.

- [ ] **Step 3: Create report**

Create `docs/superpowers/reports/2026-04-26-agent-command-center-verification.md`:

```markdown
# Agent Command Center Verification

Date: 2026-04-26

## Commands

- `bun run verify:command-center`
- `bun run verify`

## Result

Automated command-center checks passed.

The command-center verification gates protocol snapshot schemas, sidecar snapshot-based agent construction, Rust agent/workspace storage, OpenAI auth status and missing-auth behavior, desktop UI typecheck/build, and workspace clippy with warnings denied.

## Notes

No real OpenAI API call is made by automated tests. Manual verification still requires saving an API key in the app, creating or selecting an agent, adding a workspace, and running a small task.
```

- [ ] **Step 4: Commit**

Run:

```bash
git add package.json docs/superpowers/reports/2026-04-26-agent-command-center-verification.md
git commit -m "test: verify agent command center"
```

Expected: commit succeeds.

## Acceptance Criteria

- The app can save an OpenAI API key without exposing it back to React.
- The app can list, create, edit, and delete local agent definitions, with last-agent deletion refused.
- The app can save and list local workspaces with path validation.
- The UI can select an agent and workspace, enter a task, and call `start_agent_run`.
- The Rust side sends agent and workspace snapshots to the sidecar.
- The sidecar builds an OpenAI Agents SDK `Agent` from the snapshot.
- Automated tests do not call OpenAI.
- `bun run verify:command-center` passes.
- `bun run verify` still passes.

## Manual Verification

After implementation:

1. Start the app:

```bash
cd /Users/johnny/Work/vulture/apps/desktop-shell
bunx @tauri-apps/cli dev
```

2. Save an API key in the OpenAI auth panel.
3. Create or select `Local Work Agent`.
4. Add workspace path `/Users/johnny/Work/vulture`.
5. Enter `Say hello and explain what tools you have available.`
6. Run the agent.
7. Confirm the timeline shows `run_started` and `run_completed`.

## Follow-Up Plans

1. Tool approval response loop.
2. Streaming run events.
3. Durable conversation history.
4. Native folder picker for workspace creation.
5. Multi-agent handoff builder.
