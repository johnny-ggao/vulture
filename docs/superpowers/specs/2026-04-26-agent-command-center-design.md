# Agent Command Center Design

Date: 2026-04-26

## Goal

Build the first usable Accio-like local command center for Vulture: create and edit local agents, configure OpenAI API access, select a workspace, enter a task, run a real OpenAI Agents SDK agent, and see run events in the desktop UI.

This is a product-usable slice, not a visual polish slice. The UI should be functional, dense, and clear; refined styling can come later.

## Confirmed Decisions

- Layout direction: Accio-like command center.
- First priority: usability and real execution, not UI polish.
- Model runtime: OpenAI Agents SDK in the Bun sidecar.
- Authentication: OpenAI API key stored locally, not ChatGPT subscription OAuth.
- API key source order:
  1. macOS Keychain value saved by the app.
  2. Existing `OPENAI_API_KEY` environment variable.
- ChatGPT subscriptions must not be treated as API credentials. OpenAI API usage is billed and authenticated separately from ChatGPT subscriptions.
- OAuth is explicitly out of scope for OpenAI API authentication in this slice. Keep the auth module shaped so another provider can be added later if OpenAI offers a supported desktop delegated-auth flow.

## Current Starting Point

The current app has:

- A fixed profile, `default`.
- A fixed active agent id, `local-work-agent`.
- A mock `Run Agent` button.
- Browser pairing panel.
- Sidecar tool adapters for shell and browser snapshot/click.
- Rust policy/audit routing for tool requests.

The current app does not have:

- User-created agent definitions.
- API key setup in UI.
- Real OpenAI run from the desktop shell.
- Workspace selection.
- A persisted task/run console.

## Product Shape

Use the C layout from the brainstorming companion:

```text
Left rail
  Profile
  Agents
  Workspaces
  Templates

Main console
  Task input
  Agent selector
  Workspace selector
  Run button
  Run event timeline

Right inspector
  Agent configuration
  Tool toggles
  OpenAI auth status
  Browser status
```

First implementation can keep this in one React component if necessary, but the data model and Tauri commands must be separated cleanly so the UI can be split later.

## Data Model

Profile data stays under:

```text
~/Library/Application Support/Vulture/profiles/default/
```

Agent definitions live under:

```text
profiles/default/agents/<agent-id>/agent.json
profiles/default/agents/<agent-id>/instructions.md
```

Workspace definitions live under:

```text
profiles/default/workspaces/<workspace-id>.json
```

Run records for this slice can stay in memory in the UI after each run. Persistent conversation/run history is out of scope for this slice.

### Agent Definition

```json
{
  "id": "local-work-agent",
  "name": "Local Work Agent",
  "description": "General local work assistant",
  "model": "gpt-5.4",
  "reasoning": "medium",
  "tools": ["shell.exec", "browser.snapshot", "browser.click"],
  "createdAt": "2026-04-26T00:00:00.000Z",
  "updatedAt": "2026-04-26T00:00:00.000Z"
}
```

Instructions are stored as Markdown in `instructions.md` to keep long prompts readable and editable outside the app.

### Workspace Definition

```json
{
  "id": "vulture",
  "name": "Vulture",
  "path": "/Users/johnny/Work/vulture",
  "createdAt": "2026-04-26T00:00:00.000Z",
  "updatedAt": "2026-04-26T00:00:00.000Z"
}
```

For the first version, workspace creation can be path text input instead of a native folder picker. The Rust side must canonicalize and validate the path exists before saving.

## Auth Model

OpenAI API access is handled by Rust, not React.

React may ask:

```text
get_openai_auth_status
set_openai_api_key
clear_openai_api_key
```

React must not receive the stored secret after saving it.

Rust stores the API key in macOS Keychain under the existing profile secret reference:

```text
vulture:profile:default:openai
```

Auth status returned to UI:

```json
{
  "configured": true,
  "source": "keychain"
}
```

Allowed sources:

```text
keychain
environment
missing
```

When starting a real run, Rust resolves the API key in this order:

1. Keychain secret.
2. `OPENAI_API_KEY` inherited from the desktop shell environment.

If neither exists, Rust returns a recoverable error that the UI displays as:

```text
OpenAI API key required.
```

The UI can include a button/link label for opening the OpenAI Platform API keys page, but it should not embed credentials or try to OAuth into ChatGPT.

## Runtime Flow

```text
User selects agent + workspace and enters task
  -> React calls start_agent_run(agentId, workspaceId, input)
  -> Rust loads agent definition and workspace definition
  -> Rust resolves OpenAI API key
  -> Rust starts Bun sidecar with OPENAI_API_KEY in sidecar env
  -> Rust sends run.create params including agent config snapshot
  -> Sidecar builds an OpenAI Agents SDK Agent from that snapshot
  -> Sidecar runs the agent
  -> Sidecar emits run events and tool.request messages over stdout
  -> Rust routes tool.request through policy/audit
  -> Rust returns run events to React
```

The first real-run implementation can stay request/response rather than live streaming. The UI shows events after the sidecar process returns. Streaming can be added later once the protocol has stable event delivery and approval response loops.

## Sidecar Contract

Extend `RunCreateParams` so Rust can send an agent snapshot:

```json
{
  "profileId": "default",
  "workspaceId": "vulture",
  "agentId": "local-work-agent",
  "input": "Summarize this repo",
  "agent": {
    "id": "local-work-agent",
    "name": "Local Work Agent",
    "instructions": "You are Vulture's local work agent...",
    "model": "gpt-5.4",
    "tools": ["shell.exec", "browser.snapshot", "browser.click"]
  },
  "workspace": {
    "id": "vulture",
    "path": "/Users/johnny/Work/vulture"
  }
}
```

The sidecar must not read profile folders directly. Rust sends the runtime snapshot.

Tool creation rules:

- Include `shell_exec` only if the agent has `shell.exec`.
- Include `browser_snapshot` only if the agent has `browser.snapshot`.
- Include `browser_click` only if the agent has `browser.click`.

If the model requests a tool, the sidecar still sends `tool.request`; Rust remains the authority boundary.

## Tauri Commands

Add these commands:

```text
list_agents
get_agent
save_agent
delete_agent
list_workspaces
save_workspace
delete_workspace
get_openai_auth_status
set_openai_api_key
clear_openai_api_key
start_agent_run
```

`delete_agent` must refuse to delete the last remaining agent.

`save_agent` validation:

- `id`: lowercase slug, stable once created.
- `name`: non-empty.
- `model`: non-empty.
- `instructions`: non-empty.
- `tools`: subset of supported tools.

Supported tools for this slice:

```text
shell.exec
browser.snapshot
browser.click
```

`save_workspace` validation:

- `id`: lowercase slug.
- `name`: non-empty.
- `path`: existing local directory.

## UI Behavior

On launch:

1. Load profile.
2. Load auth status.
3. Load agents.
4. Load workspaces.
5. Select active profile agent if it exists; otherwise select first agent.

Left rail:

- Agents list.
- Workspaces list.
- Create Agent.
- Add Workspace.

Main console:

- Agent selector.
- Workspace selector.
- Task input.
- Run button.
- Event timeline.

Right inspector:

- Selected agent editor.
- Tool toggles.
- OpenAI auth setup.
- Browser status from existing Browser panel.

Run button disabled when:

- No agent selected.
- No workspace selected.
- Task input is empty.
- Auth status is missing.
- A run is already active.

## Templates

Ship three local templates in code, not a marketplace:

```text
Local Work Agent
  tools: shell.exec, browser.snapshot, browser.click

Coder
  tools: shell.exec

Browser Researcher
  tools: browser.snapshot, browser.click
```

Templates create normal editable agent definitions. No template sync or remote catalog in this slice.

## Error Handling

Auth missing:

```text
OpenAI API key required.
```

Invalid API key or quota error from OpenAI:

```text
OpenAI request failed: <SDK error message>
```

Invalid workspace path:

```text
Workspace path must be an existing directory.
```

Sidecar failed:

```text
Agent runtime failed: <stderr or error message>
```

Tool approval behavior:

The first real-run slice can return the existing placeholder tool result for requested tools. The UI must show that a tool was requested. A full interactive approval/result loop is a follow-up.

## Testing

Rust tests:

- Agent store creates default agent.
- Agent store saves and reloads instructions plus metadata.
- Agent store rejects invalid ids and unsupported tools.
- Workspace store rejects missing paths.
- Auth status reports `missing`, `environment`, and `keychain` sources where testable.
- `start_agent_run` refuses missing auth before launching sidecar.
- Sidecar process receives `OPENAI_API_KEY` only in the child environment.

TypeScript tests:

- Protocol validates run.create with agent/workspace snapshots.
- Sidecar builds tools based on requested tool names.
- Sidecar rejects unsupported tool names.
- Real-run path can be tested with a mocked `run` function so CI does not call OpenAI.

Manual checks:

- Save API key through UI.
- Create an agent.
- Add current repo as workspace.
- Run a simple task.
- Confirm events appear.

## Explicit Non-Goals

- ChatGPT subscription OAuth for OpenAI API.
- Multi-agent handoff builder.
- Streaming run UI.
- Durable conversation history.
- Approval response loop for tool results.
- Browser tab automation beyond existing snapshot/click tool request adapters.
- Marketplace or plugin installation.
- Visual polish beyond readable functional layout.

## Follow-Up Slices

1. Interactive approval/result loop for tool calls.
2. Streaming run events from sidecar to UI.
3. Durable conversations and run history.
4. Multi-agent handoffs and templates.
5. Browser transport and CDP action execution.
