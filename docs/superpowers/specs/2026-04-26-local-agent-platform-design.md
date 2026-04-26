# Local Agent Platform Design

Date: 2026-04-26

## Goal

Build a local-only hybrid desktop agent platform inspired by Accio-like workflow architecture, with OpenAI Agents SDK for orchestration and Tauri for the desktop shell. The product should feel like a local workbench rather than a cloud account product: no cloud account system, no billing, no team sync in the first implementation. Local profiles replace accounts.

The first platform target is macOS. The architecture should keep future Windows/Linux support possible without forcing that complexity into the first implementation.

## Confirmed Decisions

- Product target: full platform foundation, implemented in milestones.
- Primary use case: hybrid local work agent, with coding as a core capability.
- Desktop shell: Tauri.
- UI stack: React + TypeScript.
- Agent runtime: Bun sidecar running OpenAI Agents SDK.
- Architecture route: Modular Core.
- Browser control: full Accio-like browser subsystem in the first platform design.
- Identity model: multiple local profiles, no cloud account.
- Data model: local-first, profile-scoped, with secrets in macOS Keychain.

## System Boundary

The system is split into four trust zones:

```text
React UI
  No secrets, no direct filesystem, no direct sidecar access.

Tauri Rust Core
  Trusted local kernel.
  Owns keychain, file access, PTY, shell execution, browser relay lifecycle,
  profile storage, permissions, audit logs, app settings, and later updater.

Bun Agent Sidecar
  Semi-trusted orchestration process.
  Runs OpenAI Agents SDK, agent handoffs, MCP clients, model streaming,
  tool planning, and trace event generation.

Chrome Extension + Browser Relay
  High-risk browser-control subsystem.
  Explicitly enabled and paired per profile, fully audited.
```

The main rule is: LLM-side code never receives raw ambient authority. The sidecar can request tools, but Rust decides whether each request is allowed, requires approval, or is denied.

## Repository Layout

Use a monorepo so the UI, Rust app, sidecar, extension, and protocol schemas can evolve together.

```text
apps/desktop-ui
  React + TypeScript UI.

apps/desktop-shell
  Tauri Rust app, process supervision, system integration.

apps/agent-sidecar
  Bun + OpenAI Agents SDK runtime.

extensions/browser
  Chrome MV3 extension for browser control.

crates/core
  Shared Rust domain types.

crates/tool-gateway
  Rust tool execution, policy, audit.

packages/protocol
  Shared JSON schemas and generated TypeScript/Rust bindings.
```

## Runtime Data Flow

```text
User sends message
  -> UI sends conversation event to Rust
  -> Rust persists user message
  -> Rust asks sidecar to run agent
  -> Sidecar streams model and tool events
  -> Tool requests pause at Rust Tool Gateway
  -> Rust policy decides allow / ask / deny
  -> UI shows approval when needed
  -> Tool result returns to sidecar
  -> Sidecar completes response
  -> Rust persists full trace and assistant message
```

Use two local communication protocols:

- UI <-> Rust: Tauri commands and events.
- Rust <-> Bun sidecar: stdio JSON-RPC.

Stdio is preferred for the sidecar because it avoids port conflicts, is easy to supervise, and does not expose a local network service.

Example sidecar protocol:

```json
{ "id": "1", "method": "run.create", "params": { "profileId": "default", "agentId": "local-work-agent", "input": "summarize this repo" } }
{ "method": "run.event", "params": { "type": "model_delta", "text": "..." } }
{ "id": "2", "method": "tool.request", "params": { "tool": "shell.exec", "cwd": "/path/to/workspace", "argv": ["npm", "test"] } }
{ "id": "2", "result": { "exitCode": 0, "stdout": "...", "stderr": "" } }
```

Rust owns durable state. Bun owns transient run state.

The sidecar receives profile, agent, tool, and MCP configuration as runtime
snapshots from Rust. It must not scan profile folders, load arbitrary local
configuration files, or persist settings by itself.

## Local Storage And Profiles

Profiles replace accounts. Each profile owns API key references, agent definitions, plugins, skills, memory, browser settings, permissions, audit history, and conversations.

```text
~/Library/Application Support/Vulture/
  profiles/
    default/
      profile.json
      settings.json
      agents/
      conversations/
      workspaces/
      plugins/
      skills/
      permissions/
      memory/
      browser/
      audit/
  sidecar/
  logs/
  cache/
```

Secrets must not be written to JSON. OpenAI API keys and connector tokens are stored in macOS Keychain and referenced by stable secret IDs.

```json
{
  "id": "default",
  "name": "Default",
  "openaiSecretRef": "vulture:profile:default:openai",
  "activeAgentId": "local-work-agent"
}
```

### Agent Layout

```text
profiles/default/agents/local-work-agent/
  agent.json
  instructions.md
  tools.json
  skills/
  memory/
  sessions/
```

Example:

```json
{
  "id": "local-work-agent",
  "name": "Local Work Agent",
  "model": "gpt-5.4",
  "reasoning": "medium",
  "tools": ["file.read", "file.write", "shell.exec", "browser.control", "mcp.*"],
  "handoffs": ["researcher", "coder", "browser"]
}
```

### Workspace Layout

Workspaces are explicit local folders selected by the user. Workspace-specific generated metadata lives inside a hidden directory when possible.

```text
<workspace>/.vulture/
  workspace.json
  sessions/
  artifacts/
  index/
```

### Persistence Choices

- SQLite: conversations, messages, runs, tool events, audit records, workspace index.
- JSON/Markdown: profiles, agents, tools, skills, plugin manifests, instructions.
- Keychain: secrets.
- Filesystem: artifacts, screenshots, generated files, browser captures.

This balances queryability with user-editable local files.

## Permission Model And Tool Gateway

The Tool Gateway is the trust boundary between the sidecar and local authority.

```text
Sidecar tool request
  -> Rust Tool Gateway
  -> Policy engine
  -> Optional user approval
  -> Executor
  -> Audit log
  -> Tool result
```

Every tool call resolves to:

```text
allow       run immediately
ask         pause and request user approval
deny        reject with reason
```

Approval choices:

```text
allow once
allow for this session
allow for this workspace
always allow matching rule
deny once
always deny matching rule
```

Policies are scoped by profile, agent, workspace, and tool.

```text
profiles/default/permissions/
  policy.jsonl
  audit.sqlite
```

Example rule:

```json
{
  "effect": "allow",
  "scope": {
    "agentId": "local-work-agent",
    "workspaceId": "vulture",
    "tool": "shell.exec"
  },
  "match": {
    "commandPrefix": ["npm", "test"]
  },
  "constraints": {
    "cwdInsideWorkspace": true,
    "network": false
  }
}
```

### Tool Classes

Start with:

```text
file.read          ask outside workspace, allow inside workspace
file.write         ask by default, allow generated artifacts after approval
shell.exec         ask by default, deny destructive commands unless explicitly approved
terminal.pty       user-started interactive shell only
browser.control    ask when attaching, then audit each high-risk action
mcp.invoke         inherits MCP server trust level and tool policy
git.*              ask for mutating commands, allow read-only status/diff/log
```

Rust owns shell execution and PTY. Bun never calls `child_process` or writes arbitrary files directly.

Prefer argv over raw shell strings:

```json
{
  "tool": "shell.exec",
  "cwd": "/path/to/workspace",
  "argv": ["npm", "test"],
  "timeoutMs": 120000,
  "env": { "CI": "1" },
  "network": "default-deny"
}
```

Raw shell is a separate `shell.exec_raw` tool with stricter approval.

### Audit Trail

Audit every meaningful event:

- user message
- model run started/completed
- tool requested
- policy decision
- approval prompt shown
- user approval/denial
- command started/completed
- file write diff summary
- browser attach/action
- MCP server/tool invocation

Audit records are append-only SQLite rows. The UI renders them as a run timeline.

## Browser-Control Subsystem

Browser control is a separate high-risk subsystem with its own enable switch, pairing, audit trail, and permission prompts.

```text
Chrome Extension
  <-> local encrypted WebSocket relay
  <-> Rust Browser Relay Manager
  <-> Tool Gateway
  <-> Bun sidecar / Agents SDK
```

The Chrome extension uses MV3 and requires explicit user installation. Required permissions:

```json
{
  "permissions": ["debugger", "tabs", "tabGroups", "windows", "scripting", "storage", "alarms", "notifications"],
  "host_permissions": ["<all_urls>"]
}
```

### Pairing And Transport

Do not use an unauthenticated localhost service.

Use:

- relay listens only on `127.0.0.1`
- random per-profile relay port
- one-time pairing token shown by app and stored by extension
- app public key advertised through the pairing screen as a fingerprint
- extension generates an ephemeral key pair during pairing
- pairing token authorizes the first key exchange only
- per-session AES-GCM encryption
- protocol version negotiation
- reconnect with bounded backoff

After pairing, reconnects authenticate with the stored extension identity and a
fresh nonce challenge. The pairing token is invalidated immediately after first
use.

Protocol shape:

```json
{ "method": "Extension.hello", "params": { "protocolVersion": 1, "extensionVersion": "0.1.0", "pairingToken": "..." } }
{ "method": "Extension.helloAck", "params": { "status": "ok", "encrypted": true } }
{ "id": "42", "method": "forwardCDPCommand", "params": { "sessionId": "...", "method": "Page.captureScreenshot" } }
{ "id": "42", "result": { "data": "..." } }
```

### Browser Capabilities

First browser implementation includes:

- discover tabs
- attach/detach debugger
- create/activate/close agent-created tabs
- retain tabs
- capture screenshot
- extract page text and simplified DOM
- mark clickable elements
- click/input/scroll/keypress
- forward selected CDP commands
- prevent closing user tabs unless explicitly approved
- reconnect and reattach after extension/browser restart

Expose constrained browser tools to Agents SDK through Rust:

```text
browser.open
browser.attach
browser.snapshot
browser.click
browser.input
browser.scroll
browser.keypress
browser.extract
browser.close_agent_tabs
browser.forward_cdp_limited
```

Full raw CDP forwarding is internal and not a default agent tool.

## Agents SDK Sidecar

The Bun sidecar owns orchestration:

```text
Bun Sidecar
  Agents SDK
  Agent registry
  Run manager
  Tool adapters
  MCP client manager
  Handoff coordinator
  Trace/event streamer
```

Each local agent definition maps to an OpenAI Agents SDK agent.

Start with built-in agents:

```text
local-work-agent   default orchestrator
coder              code reading/editing/testing
browser            browser task specialist
researcher         web/MCP/document research
writer             docs and artifact drafting
```

Agents SDK tools are thin adapters. They validate schema, send a `tool.request` to Rust, and return Rust's result.

```ts
tool("shell.exec", schema, async input => {
  return await rustToolGateway.request("shell.exec", input)
})
```

No adapter directly calls shell, filesystem, or browser CDP APIs.

### Handoffs

Use handoffs for specialized work:

```text
default -> coder       codebase modifications
default -> browser     browser-control task
default -> researcher  source gathering and summarization
default -> writer      final docs, specs, long-form output
```

Handoff events are visible in the run timeline.

### MCP, Plugins, And Skills

MCP servers are local plugins configured per profile:

```json
{
  "id": "filesystem-docs",
  "transport": "stdio",
  "command": "bun",
  "args": ["run", "server.ts"],
  "trust": "ask",
  "enabled": true
}
```

Trust levels:

```text
trusted       tools may run under normal policy
ask           every new tool/server requires approval
disabled      installed but unavailable to agents
```

Plugins provide capabilities. Skills provide behavior and instructions.

```text
Plugin
  manifest, MCP server, UI settings, bundled skills, optional tool schemas

Skill
  Markdown instructions, scripts/assets, activation rules
```

Phase 1 loads plugins from local folders only. Later phases can add signed packages, import/export, and registry metadata.

## UI And Workspace Experience

The app should feel like a workbench, not a plain chat window.

```text
Top:    Profile / Workspace / Current Agent / Run State
Left:   Conversations / Agents / Plugins / Skills / Automations
Center: Chat and run timeline
Right:  Files / Artifacts / Browser / Terminal / Trace Inspector
Bottom: Approval bar / tool status / token and cost summary
```

Core pages:

```text
Home
  Recent workspaces, recent conversations, profile state, OpenAI key state.

Workspace
  Main workbench and highest priority page.

Agents
  Local agent list, instructions editor, model, tools, permissions, handoffs.

Plugins
  Local plugin and MCP server management, enable/disable, trust levels.

Skills
  Local skill library.

Browser Control
  Extension install state, pairing, current tabs, permissions.

Settings
  Profile, keychain, model defaults, data paths, update, logs.
```

Visual style should be quiet, professional, dense, and operational. The first screen is the actual workbench or recent workspace view, not a marketing landing page.

## Phased Implementation Scope

The architecture targets the full platform, but delivery is staged:

```text
Milestone 1: Shell
  Tauri app skeleton, React UI, profile creation, settings, keychain.

Milestone 2: Agent Core
  Bun sidecar, OpenAI Agents SDK run loop, streaming, basic chat persistence.

Milestone 3: Tool Gateway
  file read/write, shell.exec, terminal PTY, policy approval, audit timeline.

Milestone 4: Browser Control
  MV3 extension, encrypted relay, tabs, screenshot, click/input/scroll/extract.

Milestone 5: Workspace Experience
  file tree, artifact previews, trace inspector, run replay.

Milestone 6: MCP / Plugins / Skills
  local plugin loader, MCP stdio, skill activation, built-in agents.

Milestone 7: Platform Layer
  automations, memory, connector framework, import/export, updater.
```

First implementation does not include:

- cloud accounts
- team collaboration
- plugin marketplace
- Windows/Linux support
- mobile app
- remote sync
- billing or quota system
- general RPA workflow builder

## Error Handling And Recovery

All cross-boundary calls return structured errors:

```json
{
  "code": "TOOL_PERMISSION_DENIED",
  "message": "Shell command requires approval",
  "recoverable": true,
  "details": {
    "tool": "shell.exec",
    "cwd": "/path/to/workspace",
    "policyRule": "workspace-shell-default"
  }
}
```

Run state machine:

```text
created -> running -> waiting_for_approval -> running
running -> completed
running -> failed
running -> interrupted
waiting_for_approval -> denied
waiting_for_approval -> expired
```

Rust core is the supervisor:

- sidecar crash marks active runs as `interrupted`
- UI displays that the agent runtime restarted
- terminal PTY exit preserves output and exit code
- browser relay disconnect preserves tab/session state and prompts reattach
- app restart restores recent workspace, conversation, and pending approvals

## Testing Strategy

Rust core:

- policy matching
- path boundary checks
- argv validation
- audit append logic
- keychain reference handling
- sidecar stdio protocol
- tool gateway requests
- PTY lifecycle

Sidecar:

- agent registry
- tool adapter validation
- MCP config parsing
- handoff routing
- event streaming
- protocol contract fixtures

UI:

- approval prompt
- trace timeline
- workspace panels
- browser state badges
- create profile
- open workspace
- run basic agent
- approve shell command
- inspect audit trail

Browser extension:

- pairing
- reconnect
- tab discovery
- attach/detach
- screenshot/extract/click/input
- blocked domain policy

## Security Verification

Each release must verify:

- sidecar cannot directly read/write arbitrary files
- sidecar cannot directly spawn shell
- WebView has no Node authority
- all Tauri commands validate parameters
- all tool calls enter audit
- workspace-external access triggers approval
- raw shell requires stricter approval
- browser attach requires user enablement
- extension relay rejects unpaired connections
- secrets stay in Keychain and are not logged
- MCP servers default to `ask`

## Acceptance Criteria For The First Complete Platform Slice

The first complete local platform slice is done when:

1. A user can create a local profile and store an OpenAI API key in Keychain.
2. A user can open a workspace and start an agent run.
3. The agent can read files, request file edits, and request shell commands.
4. Rust Tool Gateway can ask, allow, deny, and audit tool calls.
5. Sidecar crash does not crash the app; active run becomes `interrupted`.
6. Browser extension can pair and perform screenshot, click, input, and extract.
7. Timeline shows model output, tool events, handoffs, approvals, and errors.
8. Plugins and MCP servers can be loaded from local folders under explicit trust levels.
