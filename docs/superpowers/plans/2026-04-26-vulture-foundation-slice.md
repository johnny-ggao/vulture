# Vulture Foundation Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable local-only Vulture platform slice: monorepo, shared protocol, Rust core, Rust tool gateway, Bun Agents SDK sidecar, and a Tauri/React workbench shell that can start a mock agent run and route tool requests through Rust.

**Architecture:** Rust owns local authority, profile state, approvals, and audit. Bun owns transient OpenAI Agents SDK orchestration and communicates with Rust only through stdio JSON-RPC. React talks only to Tauri commands/events and never receives raw filesystem, shell, keychain, or sidecar authority.

**Tech Stack:** Tauri 2, Rust 1.78+, React 18, TypeScript 5, Vite, Bun, `@openai/agents` 0.8.x, Zod 4, SQLite through `rusqlite`, macOS Keychain through `keyring`.

---

## Scope

This plan implements Milestones 1-3 from the approved spec and leaves browser control, plugins, skills, automations, and MCP loading for later plans. The end state is a working desktop shell with:

- local profile creation
- OpenAI secret reference storage path and keychain adapter
- sidecar supervision through stdio
- mock agent run streaming
- shared protocol validation in TypeScript
- Rust policy decision for `file.read`, `file.write`, and `shell.exec`
- audit records written to SQLite
- UI panes for workbench, approvals, and trace events

The current directory is not a git repository. Task 1 initializes git so later tasks can commit.

## File Structure

Create these files:

```text
package.json
bunfig.toml
tsconfig.base.json
Cargo.toml
rust-toolchain.toml
.gitignore

packages/protocol/package.json
packages/protocol/tsconfig.json
packages/protocol/src/index.ts
packages/protocol/src/index.test.ts

crates/core/Cargo.toml
crates/core/src/lib.rs
crates/core/src/error.rs
crates/core/src/paths.rs
crates/core/src/profile.rs
crates/core/src/storage.rs

crates/tool-gateway/Cargo.toml
crates/tool-gateway/src/lib.rs
crates/tool-gateway/src/audit.rs
crates/tool-gateway/src/policy.rs
crates/tool-gateway/src/types.rs

apps/agent-sidecar/package.json
apps/agent-sidecar/tsconfig.json
apps/agent-sidecar/src/agents.ts
apps/agent-sidecar/src/main.ts
apps/agent-sidecar/src/rpc.ts
apps/agent-sidecar/src/tools.ts
apps/agent-sidecar/src/rpc.test.ts

apps/desktop-ui/package.json
apps/desktop-ui/index.html
apps/desktop-ui/tsconfig.json
apps/desktop-ui/vite.config.ts
apps/desktop-ui/src/App.tsx
apps/desktop-ui/src/main.tsx
apps/desktop-ui/src/styles.css

apps/desktop-shell/Cargo.toml
apps/desktop-shell/build.rs
apps/desktop-shell/tauri.conf.json
apps/desktop-shell/src/main.rs
apps/desktop-shell/src/commands.rs
apps/desktop-shell/src/sidecar.rs
apps/desktop-shell/src/state.rs
```

Modify these files after creation:

```text
package.json
Cargo.toml
apps/desktop-shell/Cargo.toml
apps/desktop-ui/package.json
apps/agent-sidecar/package.json
```

## References

- OpenAI Agents SDK TypeScript install and basics: https://openai.github.io/openai-agents-js/
- Agents SDK tools guide: https://openai.github.io/openai-agents-js/guides/tools/
- Agents SDK handoffs guide: https://openai.github.io/openai-agents-js/guides/handoffs/

## Task 1: Initialize Monorepo

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.base.json`
- Create: `Cargo.toml`
- Create: `rust-toolchain.toml`
- Create: `.gitignore`

- [ ] **Step 1: Initialize git**

Run:

```bash
git init
```

Expected: output includes `Initialized empty Git repository`.

- [ ] **Step 2: Create root JavaScript workspace files**

Create `package.json`:

```json
{
  "name": "vulture",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev": "bun --filter @vulture/desktop-ui dev",
    "test": "bun test packages/protocol/src apps/agent-sidecar/src",
    "typecheck": "bun --filter '*' typecheck",
    "build": "bun --filter '*' build"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

Create `bunfig.toml`:

```toml
[install]
exact = false
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 3: Create root Rust workspace files**

Create `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = [
  "apps/desktop-shell",
  "crates/core",
  "crates/tool-gateway"
]

[workspace.package]
edition = "2021"
license = "UNLICENSED"

[workspace.dependencies]
anyhow = "1"
chrono = { version = "0.4", features = ["serde"] }
keyring = "3"
rusqlite = { version = "0.31", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "2", features = [] }
tauri-build = "2"
thiserror = "1"
tokio = { version = "1", features = ["macros", "process", "rt-multi-thread", "sync"] }
uuid = { version = "1", features = ["serde", "v4"] }
```

Create `rust-toolchain.toml`:

```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

Create `.gitignore`:

```gitignore
.DS_Store
node_modules/
target/
dist/
.tauri/
*.log
*.sqlite
*.db
.env
.env.*
!.env.example
```

- [ ] **Step 4: Verify root workspaces**

Run:

```bash
bun install
cargo metadata --no-deps
```

Expected: `bun install` succeeds; `cargo metadata` fails only if member crates are not created yet. Continue to Task 2 before requiring Cargo success.

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json bunfig.toml tsconfig.base.json Cargo.toml rust-toolchain.toml .gitignore
git commit -m "chore: initialize vulture monorepo"
```

Expected: commit succeeds.

## Task 2: Shared Protocol Package

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/index.test.ts`

- [ ] **Step 1: Write protocol tests**

Create `packages/protocol/package.json`:

```json
{
  "name": "@vulture/protocol",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "bun test src",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

Create `packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Create `packages/protocol/src/index.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  JsonRpcRequest,
  RunCreateParams,
  ToolRequestParams,
  makeEvent,
} from "./index";

describe("protocol schemas", () => {
  test("validates run.create params", () => {
    const parsed = RunCreateParams.parse({
      profileId: "default",
      workspaceId: "vulture",
      agentId: "local-work-agent",
      input: "summarize this repo",
    });

    expect(parsed.agentId).toBe("local-work-agent");
  });

  test("validates shell tool requests as argv", () => {
    const parsed = ToolRequestParams.parse({
      runId: "run_1",
      tool: "shell.exec",
      input: {
        cwd: "/tmp/workspace",
        argv: ["bun", "test"],
        timeoutMs: 120000,
      },
    });

    expect(parsed.tool).toBe("shell.exec");
  });

  test("rejects rpc requests without a method", () => {
    expect(() => JsonRpcRequest.parse({ id: "1", params: {} })).toThrow();
  });

  test("creates typed events", () => {
    const event = makeEvent("run_1", "model_delta", { text: "hello" });
    expect(event.type).toBe("model_delta");
    expect(event.runId).toBe("run_1");
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
bun test packages/protocol/src/index.test.ts
```

Expected: FAIL with module export errors because `packages/protocol/src/index.ts` does not exist.

- [ ] **Step 3: Implement protocol schemas**

Create `packages/protocol/src/index.ts`:

```ts
import { z } from "zod";

export const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

export const JsonRpcId = z.union([z.string(), z.number()]);

export const JsonRpcRequest = z.object({
  id: JsonRpcId.optional(),
  method: z.string().min(1),
  params: z.record(z.string(), JsonValue).optional(),
});

export const JsonRpcSuccess = z.object({
  id: JsonRpcId,
  result: JsonValue,
});

export const JsonRpcError = z.object({
  id: JsonRpcId.optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean().default(false),
    details: z.record(z.string(), JsonValue).optional(),
  }),
});

export const RunCreateParams = z.object({
  profileId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.string().min(1),
});

export const ToolName = z.enum([
  "file.read",
  "file.write",
  "shell.exec",
  "terminal.pty",
  "browser.control",
  "mcp.invoke",
]);

export const ToolRequestParams = z.object({
  runId: z.string().min(1),
  tool: ToolName.or(z.string().regex(/^git\./)),
  input: z.record(z.string(), JsonValue),
});

export const RunEventType = z.enum([
  "run_started",
  "model_delta",
  "tool_requested",
  "tool_result",
  "approval_required",
  "run_completed",
  "run_failed",
]);

export type RunEventTypeName = z.infer<typeof RunEventType>;

export type RunEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  runId: string;
  type: RunEventTypeName;
  payload: TPayload;
  createdAt: string;
};

export function makeEvent<TPayload extends Record<string, unknown>>(
  runId: string,
  type: RunEventTypeName,
  payload: TPayload,
): RunEvent<TPayload> {
  return {
    runId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Verify protocol package**

Run:

```bash
bun test packages/protocol/src/index.test.ts
bun --filter @vulture/protocol typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/protocol
git commit -m "feat: add shared protocol package"
```

Expected: commit succeeds.

## Task 3: Rust Core Profiles And Storage Paths

**Files:**
- Modify: `Cargo.toml`
- Create: `crates/core/Cargo.toml`
- Create: `crates/core/src/lib.rs`
- Create: `crates/core/src/error.rs`
- Create: `crates/core/src/paths.rs`
- Create: `crates/core/src/profile.rs`
- Create: `crates/core/src/storage.rs`

- [ ] **Step 1: Write Rust core tests**

Create `crates/core/Cargo.toml`:

```toml
[package]
name = "vulture-core"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[dependencies]
chrono.workspace = true
keyring.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
uuid.workspace = true
```

Create `crates/core/src/lib.rs`:

```rust
pub mod error;
pub mod paths;
pub mod profile;
pub mod storage;

pub use error::{CoreError, CoreResult};
pub use paths::AppPaths;
pub use profile::{Profile, ProfileId};
pub use storage::StorageLayout;
```

Create `crates/core/src/profile.rs` with tests first:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub id: ProfileId,
    pub name: String,
    pub openai_secret_ref: String,
    pub active_agent_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_default_profile_with_keychain_ref() {
        let profile = Profile::default_profile();

        assert_eq!(profile.id.0, "default");
        assert_eq!(profile.openai_secret_ref, "vulture:profile:default:openai");
        assert_eq!(profile.active_agent_id, "local-work-agent");
    }
}
```

- [ ] **Step 2: Run failing Rust test**

Run:

```bash
cargo test -p vulture-core creates_default_profile_with_keychain_ref
```

Expected: FAIL because `Profile::default_profile` does not exist.

- [ ] **Step 3: Implement profile and storage modules**

Update root `Cargo.toml` workspace members so Cargo can run before later
workspace members exist:

```toml
[workspace]
resolver = "2"
members = [
  "crates/core"
]
```

Keep the existing `[workspace.package]` and `[workspace.dependencies]`
sections unchanged.

Replace `crates/core/src/profile.rs` with:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub id: ProfileId,
    pub name: String,
    pub openai_secret_ref: String,
    pub active_agent_id: String,
}

impl Profile {
    pub fn default_profile() -> Self {
        Self {
            id: ProfileId("default".to_string()),
            name: "Default".to_string(),
            openai_secret_ref: "vulture:profile:default:openai".to_string(),
            active_agent_id: "local-work-agent".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_default_profile_with_keychain_ref() {
        let profile = Profile::default_profile();

        assert_eq!(profile.id.0, "default");
        assert_eq!(profile.openai_secret_ref, "vulture:profile:default:openai");
        assert_eq!(profile.active_agent_id, "local-work-agent");
    }
}
```

Create `crates/core/src/error.rs`:

```rust
use thiserror::Error;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid profile id: {0}")]
    InvalidProfileId(String),
}
```

Create `crates/core/src/paths.rs`:

```rust
use std::path::{Path, PathBuf};

use crate::{CoreResult, ProfileId};

#[derive(Debug, Clone)]
pub struct AppPaths {
    root: PathBuf,
}

impl AppPaths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn profiles_dir(&self) -> PathBuf {
        self.root.join("profiles")
    }

    pub fn profile_dir(&self, profile_id: &ProfileId) -> CoreResult<PathBuf> {
        if profile_id.0.contains('/') || profile_id.0.contains("..") {
            return Err(crate::CoreError::InvalidProfileId(profile_id.0.clone()));
        }

        Ok(self.profiles_dir().join(&profile_id.0))
    }
}
```

Create `crates/core/src/storage.rs`:

```rust
use std::fs;
use std::path::PathBuf;

use crate::{AppPaths, CoreResult, Profile, ProfileId};

#[derive(Debug, Clone)]
pub struct StorageLayout {
    paths: AppPaths,
}

impl StorageLayout {
    pub fn new(paths: AppPaths) -> Self {
        Self { paths }
    }

    pub fn ensure_profile(&self, profile: &Profile) -> CoreResult<PathBuf> {
        let dir = self.paths.profile_dir(&profile.id)?;
        fs::create_dir_all(dir.join("agents"))?;
        fs::create_dir_all(dir.join("conversations"))?;
        fs::create_dir_all(dir.join("permissions"))?;

        let profile_json = serde_json::to_string_pretty(profile)?;
        fs::write(dir.join("profile.json"), profile_json)?;

        Ok(dir)
    }

    pub fn default_profile_id() -> ProfileId {
        ProfileId("default".to_string())
    }
}
```

- [ ] **Step 4: Verify Rust core**

Run:

```bash
cargo test -p vulture-core
cargo clippy -p vulture-core -- -D warnings
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add crates/core Cargo.toml
git commit -m "feat: add local profile core"
```

Expected: commit succeeds.

## Task 4: Rust Tool Gateway Policy And Audit

**Files:**
- Modify: `Cargo.toml`
- Create: `crates/tool-gateway/Cargo.toml`
- Create: `crates/tool-gateway/src/lib.rs`
- Create: `crates/tool-gateway/src/types.rs`
- Create: `crates/tool-gateway/src/policy.rs`
- Create: `crates/tool-gateway/src/audit.rs`

- [ ] **Step 1: Write policy tests**

Create `crates/tool-gateway/Cargo.toml`:

```toml
[package]
name = "vulture-tool-gateway"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[dependencies]
chrono.workspace = true
rusqlite.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
uuid.workspace = true
vulture-core = { path = "../core" }
```

Create `crates/tool-gateway/src/lib.rs`:

```rust
pub mod audit;
pub mod policy;
pub mod types;

pub use audit::AuditStore;
pub use policy::PolicyEngine;
pub use types::{PolicyDecision, ToolRequest, ToolResult};
```

Create `crates/tool-gateway/src/types.rs`:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyDecision {
    Allow,
    Ask { reason: String },
    Deny { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRequest {
    pub run_id: String,
    pub tool: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub ok: bool,
    pub output: Value,
}
```

Create `crates/tool-gateway/src/policy.rs` with tests first:

```rust
use crate::{PolicyDecision, ToolRequest};

#[derive(Debug, Default)]
pub struct PolicyEngine;

impl PolicyEngine {
    pub fn decide(&self, _request: &ToolRequest) -> PolicyDecision {
        PolicyDecision::Deny {
            reason: "policy stub".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn allows_file_read_inside_workspace() {
        let engine = PolicyEngine;
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "file.read".to_string(),
            input: json!({
                "path": "/tmp/vulture-workspace/README.md",
                "workspaceRoot": "/tmp/vulture-workspace"
            }),
        };

        assert_eq!(engine.decide(&request), PolicyDecision::Allow);
    }

    #[test]
    fn asks_for_shell_exec() {
        let engine = PolicyEngine;
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "shell.exec".to_string(),
            input: json!({ "argv": ["bun", "test"], "cwd": "/tmp/vulture-workspace" }),
        };

        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: "shell.exec requires approval".to_string()
            }
        );
    }
}
```

- [ ] **Step 2: Run failing policy tests**

Run:

```bash
cargo test -p vulture-tool-gateway policy
```

Expected: FAIL because `PolicyEngine::decide` always denies.

- [ ] **Step 3: Implement policy and audit store**

Update root `Cargo.toml` workspace members:

```toml
[workspace]
resolver = "2"
members = [
  "crates/core",
  "crates/tool-gateway"
]
```

Keep the existing `[workspace.package]` and `[workspace.dependencies]`
sections unchanged.

Replace `crates/tool-gateway/src/policy.rs` with:

```rust
use std::path::Path;

use crate::{PolicyDecision, ToolRequest};

#[derive(Debug, Default)]
pub struct PolicyEngine;

impl PolicyEngine {
    pub fn decide(&self, request: &ToolRequest) -> PolicyDecision {
        match request.tool.as_str() {
            "file.read" => self.decide_file_read(request),
            "file.write" => PolicyDecision::Ask {
                reason: "file.write requires approval".to_string(),
            },
            "shell.exec" => PolicyDecision::Ask {
                reason: "shell.exec requires approval".to_string(),
            },
            tool if tool.starts_with("git.") => PolicyDecision::Ask {
                reason: format!("{tool} requires approval"),
            },
            other => PolicyDecision::Deny {
                reason: format!("unknown tool {other}"),
            },
        }
    }

    fn decide_file_read(&self, request: &ToolRequest) -> PolicyDecision {
        let Some(path) = request.input.get("path").and_then(|value| value.as_str()) else {
            return PolicyDecision::Deny {
                reason: "file.read missing path".to_string(),
            };
        };

        let Some(workspace_root) = request
            .input
            .get("workspaceRoot")
            .and_then(|value| value.as_str())
        else {
            return PolicyDecision::Ask {
                reason: "file.read outside known workspace".to_string(),
            };
        };

        if Path::new(path).starts_with(Path::new(workspace_root)) {
            PolicyDecision::Allow
        } else {
            PolicyDecision::Ask {
                reason: "file.read outside workspace".to_string(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn allows_file_read_inside_workspace() {
        let engine = PolicyEngine;
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "file.read".to_string(),
            input: json!({
                "path": "/tmp/vulture-workspace/README.md",
                "workspaceRoot": "/tmp/vulture-workspace"
            }),
        };

        assert_eq!(engine.decide(&request), PolicyDecision::Allow);
    }

    #[test]
    fn asks_for_shell_exec() {
        let engine = PolicyEngine;
        let request = ToolRequest {
            run_id: "run_1".to_string(),
            tool: "shell.exec".to_string(),
            input: json!({ "argv": ["bun", "test"], "cwd": "/tmp/vulture-workspace" }),
        };

        assert_eq!(
            engine.decide(&request),
            PolicyDecision::Ask {
                reason: "shell.exec requires approval".to_string()
            }
        );
    }
}
```

Create `crates/tool-gateway/src/audit.rs`:

```rust
use chrono::Utc;
use rusqlite::{params, Connection, Result};
use serde_json::Value;

#[derive(Debug)]
pub struct AuditStore {
    conn: Connection,
}

impl AuditStore {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL
            )",
            [],
        )?;

        Ok(Self { conn })
    }

    pub fn append(&self, event_type: &str, payload: &Value) -> Result<()> {
        self.conn.execute(
            "INSERT INTO audit_events (created_at, event_type, payload) VALUES (?1, ?2, ?3)",
            params![Utc::now().to_rfc3339(), event_type, payload.to_string()],
        )?;

        Ok(())
    }
}
```

- [ ] **Step 4: Verify tool gateway**

Run:

```bash
cargo test -p vulture-tool-gateway
cargo clippy -p vulture-tool-gateway -- -D warnings
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add crates/tool-gateway Cargo.toml
git commit -m "feat: add tool gateway policy and audit"
```

Expected: commit succeeds.

## Task 5: Bun Agents SDK Sidecar

**Files:**
- Create: `apps/agent-sidecar/package.json`
- Create: `apps/agent-sidecar/tsconfig.json`
- Create: `apps/agent-sidecar/src/rpc.ts`
- Create: `apps/agent-sidecar/src/tools.ts`
- Create: `apps/agent-sidecar/src/agents.ts`
- Create: `apps/agent-sidecar/src/main.ts`
- Create: `apps/agent-sidecar/src/rpc.test.ts`

- [ ] **Step 1: Write sidecar RPC tests**

Create `apps/agent-sidecar/package.json`:

```json
{
  "name": "@vulture/agent-sidecar",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "bun src/main.ts",
    "test": "bun test src",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@openai/agents": "^0.8.5",
    "@vulture/protocol": "workspace:*",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

Create `apps/agent-sidecar/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Create `apps/agent-sidecar/src/rpc.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseJsonLine, serializeMessage } from "./rpc";

describe("sidecar rpc", () => {
  test("parses valid json rpc lines", () => {
    const message = parseJsonLine('{"id":"1","method":"health.check","params":{}}');
    expect(message.method).toBe("health.check");
  });

  test("serializes messages as newline-delimited json", () => {
    expect(serializeMessage({ id: "1", result: { ok: true } })).toBe(
      '{"id":"1","result":{"ok":true}}\n',
    );
  });
});
```

- [ ] **Step 2: Run failing sidecar tests**

Run:

```bash
bun test apps/agent-sidecar/src/rpc.test.ts
```

Expected: FAIL because `apps/agent-sidecar/src/rpc.ts` does not exist.

- [ ] **Step 3: Implement sidecar RPC and mock run**

Create `apps/agent-sidecar/src/rpc.ts`:

```ts
import { JsonRpcRequest } from "@vulture/protocol";

export type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string; recoverable?: boolean; details?: Record<string, unknown> };
};

export function parseJsonLine(line: string) {
  const raw = JSON.parse(line);
  return JsonRpcRequest.parse(raw);
}

export function serializeMessage(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
```

Create `apps/agent-sidecar/src/tools.ts`:

```ts
import { tool } from "@openai/agents";
import { z } from "zod";

export type ToolGateway = {
  request(toolName: string, input: Record<string, unknown>): Promise<unknown>;
};

export function createShellExecTool(gateway: ToolGateway) {
  return tool({
    name: "shell_exec",
    description: "Request a local shell command through the Rust Tool Gateway.",
    parameters: z.object({
      cwd: z.string(),
      argv: z.array(z.string()).min(1),
      timeoutMs: z.number().int().positive().default(120000),
    }),
    execute: async (input) => {
      return gateway.request("shell.exec", input);
    },
  });
}
```

Create `apps/agent-sidecar/src/agents.ts`:

```ts
import { Agent, run } from "@openai/agents";
import { makeEvent, RunCreateParams } from "@vulture/protocol";
import { createShellExecTool, type ToolGateway } from "./tools";

export function createLocalWorkAgent(gateway: ToolGateway) {
  return new Agent({
    name: "local-work-agent",
    instructions:
      "You are Vulture's local work agent. Request local actions through tools and never claim a local command ran unless a tool result confirms it.",
    model: "gpt-5.4",
    tools: [createShellExecTool(gateway)],
  });
}

export async function runAgent(params: unknown, gateway: ToolGateway) {
  const parsed = RunCreateParams.parse(params);
  const runId = `run_${Date.now()}`;

  if (process.env.VULTURE_AGENT_MODE === "mock") {
    return [
      makeEvent(runId, "run_started", { agentId: parsed.agentId }),
      makeEvent(runId, "model_delta", { text: `Mock response for: ${parsed.input}` }),
      makeEvent(runId, "run_completed", { finalOutput: "Mock run completed" }),
    ];
  }

  const agent = createLocalWorkAgent(gateway);
  const result = await run(agent, parsed.input);

  return [
    makeEvent(runId, "run_started", { agentId: parsed.agentId }),
    makeEvent(runId, "run_completed", { finalOutput: result.finalOutput ? String(result.finalOutput) : "" }),
  ];
}
```

Create `apps/agent-sidecar/src/main.ts`:

```ts
import { runAgent } from "./agents";
import { parseJsonLine, serializeMessage } from "./rpc";

const gateway = {
  async request(toolName: string, input: Record<string, unknown>) {
    process.stdout.write(
      serializeMessage({
        method: "tool.request",
        params: { runId: "pending", tool: toolName, input },
      }),
    );

    return { ok: false, reason: "interactive tool response loop is owned by Rust integration" };
  },
};

async function handleLine(line: string) {
  const request = parseJsonLine(line);

  if (request.method === "health.check") {
    return { id: request.id, result: { ok: true, runtime: "bun" } };
  }

  if (request.method === "run.create") {
    const events = await runAgent(request.params, gateway);
    return { id: request.id, result: { events } };
  }

  return {
    id: request.id,
    error: {
      code: "METHOD_NOT_FOUND",
      message: `Unknown method ${request.method}`,
      recoverable: false,
    },
  };
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const response = await handleLine(line);
    process.stdout.write(serializeMessage(response));
  }
}
```

- [ ] **Step 4: Verify sidecar**

Run:

```bash
bun install
bun test apps/agent-sidecar/src/rpc.test.ts
bun --filter @vulture/agent-sidecar typecheck
printf '{"id":"1","method":"health.check","params":{}}\n' | bun apps/agent-sidecar/src/main.ts
```

Expected: tests pass; typecheck passes; health command prints one JSON line with `"ok":true`.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/agent-sidecar bun.lock package.json
git commit -m "feat: add agents sdk sidecar"
```

Expected: commit succeeds.

## Task 6: Tauri Shell And React Workbench

**Files:**
- Modify: `Cargo.toml`
- Create: `apps/desktop-ui/package.json`
- Create: `apps/desktop-ui/index.html`
- Create: `apps/desktop-ui/tsconfig.json`
- Create: `apps/desktop-ui/vite.config.ts`
- Create: `apps/desktop-ui/src/App.tsx`
- Create: `apps/desktop-ui/src/main.tsx`
- Create: `apps/desktop-ui/src/styles.css`
- Create: `apps/desktop-shell/Cargo.toml`
- Create: `apps/desktop-shell/build.rs`
- Create: `apps/desktop-shell/tauri.conf.json`
- Create: `apps/desktop-shell/src/main.rs`
- Create: `apps/desktop-shell/src/commands.rs`
- Create: `apps/desktop-shell/src/sidecar.rs`
- Create: `apps/desktop-shell/src/state.rs`

- [ ] **Step 1: Create React workbench**

Create `apps/desktop-ui/package.json`:

```json
{
  "name": "@vulture/desktop-ui",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.10.1",
    "@vulture/protocol": "workspace:*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.8.0",
    "vite": "^5.4.0"
  }
}
```

Create `apps/desktop-ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vulture</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/desktop-ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx"
  },
  "include": ["src", "vite.config.ts"]
}
```

Create `apps/desktop-ui/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
```

Create `apps/desktop-ui/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create `apps/desktop-ui/src/App.tsx`:

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

type RunEvent = {
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
};

export function App() {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState("idle");

  async function startMockRun() {
    setStatus("running");
    const result = await invoke<RunEvent[]>("start_mock_run", {
      input: "Summarize this workspace",
    });
    setEvents(result);
    setStatus("completed");
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1>Vulture</h1>
        <button type="button">Default Profile</button>
        <button type="button">Local Work Agent</button>
      </aside>
      <main className="workspace">
        <header>
          <div>
            <p className="eyebrow">Workspace</p>
            <h2>Local Agent Workbench</h2>
          </div>
          <button type="button" onClick={startMockRun}>
            Run Agent
          </button>
        </header>
        <section className="timeline">
          <p className="status">Run state: {status}</p>
          {events.map((event, index) => (
            <article key={`${event.type}-${index}`} className="event">
              <strong>{event.type}</strong>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </article>
          ))}
        </section>
      </main>
      <aside className="inspector">
        <h2>Approvals</h2>
        <p>No pending approvals.</p>
      </aside>
    </div>
  );
}
```

Create `apps/desktop-ui/src/styles.css`:

```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f5f7f8;
  color: #162027;
}

button {
  border: 1px solid #c9d3dc;
  border-radius: 6px;
  background: #ffffff;
  color: #162027;
  font: inherit;
  padding: 8px 12px;
}

.shell {
  display: grid;
  grid-template-columns: 220px minmax(420px, 1fr) 300px;
  min-height: 100vh;
}

.sidebar,
.inspector {
  border-right: 1px solid #d8e0e7;
  background: #ffffff;
  padding: 18px;
}

.inspector {
  border-right: 0;
  border-left: 1px solid #d8e0e7;
}

.sidebar {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.workspace {
  padding: 22px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid #d8e0e7;
  padding-bottom: 18px;
}

h1,
h2,
p {
  margin: 0;
}

.eyebrow,
.status {
  color: #65727d;
  font-size: 13px;
}

.timeline {
  display: grid;
  gap: 12px;
  padding-top: 18px;
}

.event {
  border: 1px solid #d8e0e7;
  border-radius: 8px;
  background: #ffffff;
  padding: 14px;
}

pre {
  overflow: auto;
  margin: 10px 0 0;
  font-size: 12px;
}
```

- [ ] **Step 2: Create Tauri shell**

Update root `Cargo.toml` workspace members:

```toml
[workspace]
resolver = "2"
members = [
  "apps/desktop-shell",
  "crates/core",
  "crates/tool-gateway"
]
```

Keep the existing `[workspace.package]` and `[workspace.dependencies]`
sections unchanged.

Create `apps/desktop-shell/Cargo.toml`:

```toml
[package]
name = "vulture-desktop-shell"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[build-dependencies]
tauri-build.workspace = true

[dependencies]
anyhow.workspace = true
serde.workspace = true
serde_json.workspace = true
tauri.workspace = true
tokio.workspace = true
vulture-core = { path = "../../crates/core" }
vulture-tool-gateway = { path = "../../crates/tool-gateway" }
```

Create `apps/desktop-shell/build.rs`:

```rust
fn main() {
    tauri_build::build();
}
```

Create `apps/desktop-shell/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Vulture",
  "version": "0.1.0",
  "identifier": "dev.vulture.app",
  "build": {
    "beforeDevCommand": "bun --cwd ../desktop-ui dev",
    "beforeBuildCommand": "bun --cwd ../desktop-ui build",
    "devUrl": "http://127.0.0.1:5173",
    "frontendDist": "../desktop-ui/dist"
  },
  "app": {
    "windows": [
      {
        "title": "Vulture",
        "width": 1280,
        "height": 820
      }
    ]
  }
}
```

Create `apps/desktop-shell/src/state.rs`:

```rust
use vulture_tool_gateway::PolicyEngine;

#[derive(Debug)]
pub struct AppState {
    pub _policy: PolicyEngine,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            _policy: PolicyEngine,
        }
    }
}
```

Create `apps/desktop-shell/src/sidecar.rs`:

```rust
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

pub async fn run_mock_agent(input: &str) -> anyhow::Result<Vec<Value>> {
    let mut child = Command::new("bun")
        .arg("apps/agent-sidecar/src/main.ts")
        .env("VULTURE_AGENT_MODE", "mock")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()?;

    let mut stdin = child.stdin.take().expect("sidecar stdin must exist");
    let stdout = child.stdout.take().expect("sidecar stdout must exist");

    let request = json!({
        "id": "1",
        "method": "run.create",
        "params": {
            "profileId": "default",
            "workspaceId": "vulture",
            "agentId": "local-work-agent",
            "input": input
        }
    });

    stdin.write_all(format!("{request}\n").as_bytes()).await?;
    drop(stdin);

    let mut lines = BufReader::new(stdout).lines();
    let Some(line) = lines.next_line().await? else {
        return Ok(vec![]);
    };

    let response: Value = serde_json::from_str(&line)?;
    let events = response
        .get("result")
        .and_then(|result| result.get("events"))
        .and_then(|events| events.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(events)
}
```

Create `apps/desktop-shell/src/commands.rs`:

```rust
use serde_json::Value;

#[tauri::command]
pub async fn start_mock_run(input: String) -> Result<Vec<Value>, String> {
    crate::sidecar::run_mock_agent(&input)
        .await
        .map_err(|error| error.to_string())
}
```

Create `apps/desktop-shell/src/main.rs`:

```rust
mod commands;
mod sidecar;
mod state;

fn main() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![commands::start_mock_run])
        .run(tauri::generate_context!())
        .expect("failed to run Vulture desktop shell");
}
```

- [ ] **Step 3: Verify UI and shell builds**

Run:

```bash
bun install
bun --filter @vulture/desktop-ui typecheck
bun --filter @vulture/desktop-ui build
cargo check -p vulture-desktop-shell
```

Expected: all commands pass.

- [ ] **Step 4: Run desktop app**

Run:

```bash
bun --cwd apps/desktop-ui dev
```

Expected: Vite starts on a local port. In a second terminal run:

```bash
cargo run -p vulture-desktop-shell
```

Expected: Tauri window opens; clicking `Run Agent` shows `run_started`, `model_delta`, and `run_completed`.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/desktop-ui apps/desktop-shell package.json bun.lock Cargo.lock
git commit -m "feat: add desktop workbench shell"
```

Expected: commit succeeds.

## Task 7: End-To-End Verification

**Files:**
- Modify: `package.json`
- Create: `docs/superpowers/reports/2026-04-26-foundation-slice-verification.md`

- [ ] **Step 1: Add root verification script**

Modify root `package.json` scripts to:

```json
{
  "dev": "bun --filter @vulture/desktop-ui dev",
  "test": "bun test packages/protocol/src apps/agent-sidecar/src",
  "typecheck": "bun --filter '*' typecheck",
  "build": "bun --filter '*' build",
  "verify": "bun test packages/protocol/src apps/agent-sidecar/src && bun --filter '*' typecheck && cargo test && cargo clippy --workspace -- -D warnings"
}
```

- [ ] **Step 2: Run verification**

Run:

```bash
bun run verify
```

Expected: all TypeScript tests, typechecks, Rust tests, and Rust clippy pass.

- [ ] **Step 3: Create verification report**

Create `docs/superpowers/reports/2026-04-26-foundation-slice-verification.md`:

```markdown
# Foundation Slice Verification

Date: 2026-04-26

## Commands

- `bun run verify`
- `bun --filter @vulture/desktop-ui build`
- `cargo check -p vulture-desktop-shell`

## Result

All automated checks passed.

## Manual Check

The Tauri shell opens the React workbench. Clicking `Run Agent` starts the Bun sidecar in mock mode and renders `run_started`, `model_delta`, and `run_completed` events.
```

- [ ] **Step 4: Commit**

Run:

```bash
git add package.json docs/superpowers/reports/2026-04-26-foundation-slice-verification.md
git commit -m "test: verify foundation slice"
```

Expected: commit succeeds.

## Acceptance Criteria

- `git status --short` is clean after Task 7.
- `bun run verify` passes.
- `bun --filter @vulture/desktop-ui build` passes.
- `cargo check -p vulture-desktop-shell` passes.
- Tauri app opens and displays the workbench layout.
- `Run Agent` starts the mock sidecar path and displays run events.
- The sidecar package imports `@openai/agents` and exposes tools as adapters to the Rust-owned gateway boundary.
- Rust `PolicyEngine` never grants shell execution without approval.

## Follow-Up Plans

Create separate plans after this slice:

1. Browser Control Slice: MV3 extension, pairing, encrypted relay, screenshot/extract/click/input.
2. Durable Persistence Slice: SQLite conversations, messages, runs, audit, replay.
3. Approval UX Slice: allow once/session/workspace, deny once/always, audit timeline.
4. MCP And Plugins Slice: local plugin loader, MCP stdio, trust levels.
5. Skills And Built-In Agents Slice: skill activation, coder/browser/researcher/writer agent definitions, handoff timeline.
