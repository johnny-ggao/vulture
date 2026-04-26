# L0 Gateway Skeleton Design

Date: 2026-04-26
Scope: L0 only — architecture skeleton + minimum domain core
Status: Approved (brainstorm), pending implementation plan

## Goal

Refactor Vulture's process model from "Tauri shell + one-shot stdio sidecar" to "Tauri shell + long-running local HTTP Gateway", mirroring Accio's process topology. L0 only delivers the skeleton: Gateway lifecycle, package layout, domain-core types, REST/SSE protocol, and the Bun ↔ Rust tool callback safety boundary. All higher-level subsystems (Skill, Memory, MCP, Subagent, PTY, CDP browser upgrade) are explicitly out of scope and tracked separately in the roadmap.

This spec exists because the current `apps/agent-sidecar` stdio model cannot host:

- Multiple concurrent runs without manual frame multiplexing
- External clients (CLI, IDE plugins) that want to talk to the same runtime
- Streaming long-lived conversations
- A long-lived runtime that survives across multiple user requests

Accio (referenced via the bundled `Accio-0.7.1-beta-20260422-1246-arm64` pkg) solves this with a long-running HTTP Gateway on `127.0.0.1`. We adopt the same shape, adapted to Tauri's Rust shell.

## Decisions Confirmed in Brainstorming

| Topic | Decision |
|---|---|
| Scope | L0 only (skeleton + domain core); L1–L4 deferred to roadmap |
| Process model | Long-running HTTP Gateway, supervised by Tauri shell |
| Gateway language | Bun (TypeScript) |
| Repository layout | Mirror Accio's package boundaries (workspace packages parallel to `@phoenix/*`, our own naming) |
| API style | REST + SSE (no WebSocket in L0) |
| Domain types in `protocol` | Minimum-only — no Skill/Memory/MCP/Task/Subagent placeholders |
| Auth & port | 32-byte token + `runtime.json`; bind 127.0.0.1; single instance |
| Migration | Phased single-direction (4 phases, no double-track) |

## System Boundary

Four cooperating processes:

```text
┌──────────────────────────────────────────────────────────────┐
│ Tauri Shell (Rust)  — system gatekeeper                       │
│   Owns: process supervision, tool-gateway (shell.exec /       │
│   browser.*), Keychain, profile/workspace file root,          │
│   single-instance lock, log capture, auto-update.             │
│   IPC surface: 9 system-level Tauri commands only.            │
│   Internal HTTP server: 127.0.0.1:<shellPort> for tool        │
│   callbacks from Gateway.                                      │
└─────────────┬───────────────────────────┬────────────────────┘
              │ supervises child           │ HTTP callback (same token)
              ↓                            ↑
┌──────────────────────────────────┐   ┌─────────────────────────┐
│ Gateway (Bun) — agent runtime     │←─→│ desktop-ui (React)      │
│   127.0.0.1:<gatewayPort>         │   │ HTTP/SSE with token     │
│   REST + SSE for all domain ops   │   │ Tauri IPC only for      │
│   Calls LLM; plans tool calls     │   │ system-level reads      │
│   Calls Shell HTTP for execution  │   └─────────────────────────┘
└─────────────┬────────────────────┘
              │ existing browser protocol
              ↓
┌──────────────────────────────────┐
│ Chrome extension (unchanged in L0)│
└──────────────────────────────────┘
```

Trust zones:

| Zone | Trust | Capabilities |
|---|---|---|
| Tauri Shell (Rust) | Highest | Filesystem, Keychain, native processes, single-instance lock |
| Gateway (Bun) | Medium | LLM calls, persistence in profile dir under Shell-controlled paths, tool planning |
| Renderer (UI) | Low | HTTP/SSE to Gateway only; no FS, no native |
| Chrome extension | High-risk | Explicit pairing per profile, fully audited |

Hard rules:

- LLM-side code (Gateway) never executes tools directly. It can only request execution via Shell HTTP.
- UI has no FS or child-process power. All domain ops go via HTTP. Only `runtime.json` reads, Keychain, single-instance, and browser pairing go via Tauri IPC.
- Both HTTP servers bind `127.0.0.1` strictly. Binding any other address is a startup panic.
- Auth token is 32 random bytes, generated each Tauri startup. The only on-disk copy is `runtime.json` (mode `0600`). Tauri also passes the token to Gateway via the `VULTURE_GATEWAY_TOKEN` env var so Gateway never reads the file; this env exposure on the same host is acknowledged in the risk register.

## Repository Layout

```text
apps/
├── desktop-shell/              Rust · Tauri main process
│   ├── src/
│   │   ├── main.rs             startup orchestration
│   │   ├── supervisor.rs       Gateway child process supervision
│   │   ├── runtime.rs          token + port allocation, runtime.json I/O
│   │   ├── single_instance.rs  flock-based single-instance guard
│   │   ├── tool_callback.rs    axum HTTP server for /tools/{invoke,cancel,manifest}
│   │   ├── auth.rs             Keychain (retained)
│   │   ├── browser/            pairing (retained)
│   │   └── commands.rs         9 system-level Tauri commands only
│   └── (deleted across phases:
│        sidecar.rs, agent_store.rs, agent_pack.rs, workspace_store.rs)
├── desktop-ui/                 React renderer
│   └── src/
│       ├── api/                fetch wrapper + per-domain HTTP clients
│       ├── runtime/            useRuntimeDescriptor() via Tauri IPC
│       └── App.tsx             rewritten as conversation-centric chat UI
└── gateway/                    Bun · long-running HTTP server
    └── src/
        ├── main.ts             entrypoint, env validation, READY handshake
        ├── server.ts           framework wiring, auth middleware, error handler
        ├── routes/
        │   ├── healthz.ts
        │   ├── agents.ts
        │   ├── workspaces.ts
        │   ├── profile.ts
        │   ├── conversations.ts
        │   ├── runs.ts
        │   └── tools.ts        list-only proxy of Shell manifest
        ├── domain/
        │   ├── agentStore.ts
        │   ├── workspaceStore.ts
        │   ├── profileStore.ts
        │   ├── conversationStore.ts
        │   ├── messageStore.ts
        │   └── runStore.ts
        ├── tools/
        │   └── shellCallback.ts   HTTP client to Shell /tools/*
        ├── llm/                   thin wrapper around chosen LLM SDK
        ├── persistence/
        │   ├── sqlite.ts
        │   ├── migrate.ts
        │   └── migrations/*.sql
        └── agent-packs/local-work/  moved from desktop-shell

extensions/
└── browser/                    Chrome extension (unchanged in L0)

crates/
├── core/                       Rust shared domain types
│   └── src/
│       ├── profile.rs
│       ├── workspace.rs
│       └── runtime.rs          RuntimeDescriptor mirror of protocol
└── tool-gateway/               Rust tool execution + policy + audit (retained)

packages/
├── protocol/                   single source of truth for cross-language types
│   └── src/v1/
│       ├── index.ts            branded ID types, Iso8601, API_VERSION
│       ├── runtime.ts
│       ├── error.ts
│       ├── profile.ts
│       ├── workspace.ts
│       ├── agent.ts
│       ├── conversation.ts
│       ├── run.ts
│       └── tool.ts
├── common/                     TS utilities (logger, result, ids)
├── llm/                        model-provider abstraction
├── agent-runtime/              run loop, prompt assembly, RunEvent emission
└── sdk/                        public-facing SDK; L0 only re-exports protocol types
```

Package dependency direction is strictly one-way:

```text
sdk → protocol
common → protocol
llm → common, protocol
agent-runtime → llm, common, protocol
gateway → agent-runtime, llm, common, protocol
desktop-ui → protocol (types only)
```

`crates/tool-gateway` keeps its name. The two "gateways" are semantically distinct: HTTP Gateway is outward-facing for clients, tool-gateway is inward-facing for security-checked execution.

## Domain Types (`packages/protocol/src/v1/`)

L0 defines minimum types only. Skill, MCP, Memory, Task, SubagentSession, multimodal Message, and token usage are deliberately omitted; they are added (additively) in L1+ specs.

### Branded IDs and primitives

```ts
export type AgentId        = string & { readonly __brand: "AgentId" };
export type WorkspaceId    = string & { readonly __brand: "WorkspaceId" };
export type ProfileId      = string & { readonly __brand: "ProfileId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type MessageId      = string & { readonly __brand: "MessageId" };
export type RunId          = string & { readonly __brand: "RunId" };
export type ToolName       = string & { readonly __brand: "ToolName" };
export type Iso8601        = string & { readonly __brand: "Iso8601" };
export const API_VERSION = "v1" as const;
```

All IDs are uuidv7 strings (time-ordered, sortable, decentralized).

### Profile / Workspace / Agent

```ts
export interface Profile {
  id: ProfileId;
  name: string;
  activeAgentId: AgentId | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface Workspace {
  id: WorkspaceId;
  name: string;
  path: string;        // must be an existing directory
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface Agent {
  id: AgentId;
  name: string;
  description: string;
  model: string;
  reasoning: "low" | "medium" | "high";
  tools: ToolName[];
  workspace: Workspace;   // private per-agent workspace
  instructions: string;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}
```

### Conversation / Message

```ts
export interface Conversation {
  id: ConversationId;
  agentId: AgentId;
  title: string;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  content: string;        // text only in L0
  runId: RunId | null;    // assistant messages reference the run that produced them
  createdAt: Iso8601;
}
```

`MessageRole` deliberately excludes `tool`. Tool calls are RunEvents, not Messages. Messages are user-visible conversation turns only.

### Run and RunEvent

A `Run` is the container for one user turn → assistant reply. One run may contain multiple LLM calls and multiple tool calls.

```ts
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Run {
  id: RunId;
  conversationId: ConversationId;
  agentId: AgentId;
  status: RunStatus;
  triggeredByMessageId: MessageId;
  resultMessageId: MessageId | null;
  startedAt: Iso8601;
  endedAt: Iso8601 | null;
  error: AppError | null;
}

interface RunEventBase {
  runId: RunId;
  seq: number;            // monotonic, used as SSE Last-Event-ID
  createdAt: Iso8601;
}

export type RunEvent =
  | (RunEventBase & { type: "run.started"; agentId: AgentId; model: string })
  | (RunEventBase & { type: "text.delta"; text: string })
  | (RunEventBase & { type: "tool.planned"; callId: string; tool: ToolName; input: unknown })
  | (RunEventBase & { type: "tool.started"; callId: string })
  | (RunEventBase & { type: "tool.completed"; callId: string; output: unknown })
  | (RunEventBase & { type: "tool.failed"; callId: string; error: AppError })
  | (RunEventBase & { type: "tool.ask"; callId: string; tool: ToolName; reason: string; approvalToken: string })
  | (RunEventBase & { type: "run.completed"; resultMessageId: MessageId; finalText: string })
  | (RunEventBase & { type: "run.failed"; error: AppError })
  | (RunEventBase & { type: "run.cancelled" });
```

`tool.planned` vs `tool.started` are intentionally separate. `planned` is the LLM deciding to call; `started` is Shell actually executing. The gap is where policy decisions and approval prompts fit.

### Tool

```ts
export interface Tool {
  name: ToolName;          // e.g. "shell.exec", "browser.snapshot", "browser.click"
  description: string;
  inputSchema: unknown;    // JSON Schema, sourced from Shell tool-gateway manifest
  requiresApproval: boolean;
}
```

L0 does not define per-tool input shapes. They live in JSON Schema returned by Shell's `/tools/manifest`.

### Error model

```ts
export type ErrorCode =
  | "auth.token_invalid"
  | "auth.missing_keychain"
  | "agent.not_found" | "agent.invalid" | "agent.cannot_delete_last"
  | "workspace.invalid_path"
  | "conversation.not_found"
  | "run.not_found" | "run.cancelled" | "run.already_completed"
  | "tool.permission_denied" | "tool.execution_failed"
  | "llm.provider_error" | "llm.rate_limited"
  | "internal" | "internal.gateway_restarted" | "internal.shutdown";

export interface AppError {
  code: ErrorCode;
  message: string;                  // human-readable, displayable to user
  details?: Record<string, unknown>; // may include sensitive data; UI collapses by default
}
```

All non-2xx HTTP responses use `AppError` as body.

### RuntimeDescriptor

Written to `~/Library/Application Support/Vulture/runtime.json` (mode `0600`):

```ts
export interface RuntimeDescriptor {
  apiVersion: typeof API_VERSION;
  gateway: { port: number };
  shell: { port: number };
  token: string;          // 32-byte URL-safe base64
  pid: number;            // Tauri shell PID
  startedAt: Iso8601;
  shellVersion: string;
}
```

`crates/core/src/runtime.rs` mirrors this struct with identical serde behavior. Round-trip is verified by a Rust test that deserializes a TS-produced fixture.

## HTTP / SSE Protocol

Base URL: `http://127.0.0.1:<port>/v1` (port from `runtime.json`).

### Conventions

- Auth: `Authorization: Bearer <token>` required on all routes except `/healthz`.
- Body: JSON only.
- Idempotency: the three create POSTs (`POST /v1/agents`, `POST /v1/workspaces`, `POST /v1/conversations`, `POST /v1/conversations/:cid/runs`) require `Idempotency-Key: <client-uuid>`; missing → 400. Gateway caches the last 1000 keys for 10 minutes and returns the cached response on retry. Action POSTs (`/cancel`, `/approvals`) are naturally idempotent (state checks + single-use tokens) and do not require the header.
- Tracing: `X-Request-Id` is generated by Gateway if absent and echoed in the response. All logs and errors carry it.
- Pagination: not in L0. Lists return all items.
- Error response: HTTP 4xx/5xx body is `AppError`.
- HTTP status code semantics: 400 (schema), 401 (auth), 403 (forbidden), 404 (not found), 409 (state conflict), 422 (business validation), 500 (Gateway bug), 502 (LLM downstream), 503 (Gateway starting/degraded).

### Routes

System:

```text
GET  /healthz                                  no auth
     → 200 { ok, apiVersion, gatewayVersion, uptimeMs }
```

Profile (single profile in L0):

```text
GET   /v1/profile                              → 200 Profile
PATCH /v1/profile                              → 200 Profile
```

Agents:

```text
GET    /v1/agents                              → 200 { items: Agent[] }
POST   /v1/agents                              → 201 Agent | 422 agent.invalid
GET    /v1/agents/:id                          → 200 Agent | 404
PATCH  /v1/agents/:id                          → 200 Agent
DELETE /v1/agents/:id                          → 204 | 409 agent.cannot_delete_last
```

Workspaces (same shape as Agents). Per-agent private workspaces are managed inside the agent record and do not appear in this list.

Conversations:

```text
GET    /v1/conversations[?agentId=...]         → 200 { items: Conversation[] } sorted by updatedAt desc
POST   /v1/conversations                       → 201 Conversation
GET    /v1/conversations/:id                   → 200 Conversation
GET    /v1/conversations/:id/messages          → 200 { items: Message[] } asc
       [?afterMessageId=...]                   for incremental fetch
DELETE /v1/conversations/:id                   → 204
```

Runs:

```text
POST   /v1/conversations/:cid/runs             → 202 { run, message, eventStreamUrl }
       Idempotency-Key required
GET    /v1/runs/:rid                           → 200 Run
GET    /v1/runs/:rid/events                    → SSE stream
       Last-Event-ID supported for resume
       Events: id=<seq>, event=<RunEvent.type>, data=<JSON>
       Server closes stream after run.completed | run.failed | run.cancelled
       (these three are the terminal SSE event types)
       Out-of-window resume: 410 Gone (UI re-fetches run state)
POST   /v1/runs/:rid/cancel                    → 202 Run | 409 run.already_completed
       Cancel is asynchronous: 202 indicates accepted. The run's status field
       remains its current value; the actual transition to status="cancelled"
       is signalled by a run.cancelled SSE event, after which the stream closes.
POST   /v1/runs/:rid/approvals                 → 202 (resumes paused run after tool.ask)
       body: { approvalToken, decision: "allow" | "deny" }
```

Tools:

```text
GET    /v1/tools                               → 200 { items: Tool[] }
```

L0 deliberately does **not** expose `POST /v1/tools/:name/invoke`. Tools can only be triggered by the LLM inside a run. This keeps "arbitrary tool execution" off the public API.

### SSE transport

EventSource cannot send custom headers, so UI uses `fetch` + `ReadableStream` and parses SSE manually (~80 lines). Token never appears in query string. Gateway access logs do not record query strings as a defense in depth.

Gateway buffers up to 1000 events (or 10 MB) per active run in memory for resume. After this window, reconnects with stale `Last-Event-ID` get `410 Gone` and the UI re-fetches the run state.

### Schema synchronization

`packages/protocol/src/v1/` contains hand-written TypeScript types and hand-written OpenAPI 3.1 YAML for the same routes. CI runs `openapi-typescript` to reverse-generate types and diffs them against the hand-written ones. Mismatch fails the build.

True codegen (single source generating both) is L1; CI diff is sufficient for L0.

## Tool Callback Protocol (Bun → Rust)

The safety core. The LLM never executes anything; Gateway routes execution requests to Shell over local HTTP.

### Shell internal HTTP server

```text
listen   127.0.0.1:<shellPort>
auth     Authorization: Bearer <same token>
extra    X-Caller-Pid: <gateway-pid>     verified against supervised PID
routes   GET  /tools/manifest
         POST /tools/invoke
         POST /tools/cancel
         GET  /healthz
```

Shell's HTTP server is a thin `axum` wrapper around `crates/tool-gateway`. Policy and audit run inside the existing Rust crate; no policy logic moves to Gateway.

### Invoke flow

Request:

```json
{
  "callId": "call-1",
  "runId": "r-...",
  "conversationId": "c-...",
  "agentId": "local-work-agent",
  "tool": "shell.exec",
  "input": { "cwd": "...", "argv": ["ls"], "timeoutMs": 120000 },
  "context": {
    "workspace": { "id": "...", "path": "..." },
    "approval": null
  }
}
```

Synchronous response (one of):

```json
{ "callId": "...", "status": "completed", "output": {...}, "durationMs": 23 }
{ "callId": "...", "status": "failed",    "error": AppError }
{ "callId": "...", "status": "denied",    "error": AppError }
{ "callId": "...", "status": "ask",       "approvalToken": "...", "reason": "..." }
```

When `status: "ask"`, Gateway emits a `tool.ask` RunEvent. UI prompts the user and calls `POST /v1/runs/:rid/approvals` with the approval token. Gateway re-issues `/tools/invoke` with `context.approval = { token, decision: "allow", at }`. Shell verifies the approval token and proceeds.

### Long-running tools

L0 uses synchronous blocking HTTP for tool calls. Bun and Shell set HTTP read timeout to `tool.timeoutMs + 5s`. Bun's async I/O means concurrent runs do not block each other.

### Cancel

```text
POST /tools/cancel  { callId, runId }   → 200 { cancelled: true }
```

Shell sends SIGTERM to the target process.

### Manifest

Gateway calls `GET /tools/manifest` once at startup (and on Shell-initiated reload, deferred to L1) to obtain the canonical Tool list with JSON Schemas. `GET /v1/tools` simply proxies this manifest.

### Audit

`crates/tool-gateway`'s existing SQLite audit (`permissions/audit.sqlite`) is the single source of truth. Each `/tools/invoke` writes `tool.requested` before execution and `tool.completed` / `tool.failed` after. Gateway logs are debugging artefacts only.

### Security non-negotiables

1. Bind 127.0.0.1 strictly — startup panic on any other bind.
2. Token: 32 random bytes per Tauri startup, written only to `runtime.json` (mode 0600).
3. PID check: Shell `/tools/*` requires `X-Caller-Pid` matching the supervised Gateway PID.
4. Origin check: all endpoints reject requests with `Origin` headers other than absent, `null`, or `tauri://localhost`. CORS is not enabled.
5. Audit before execution: `tool.requested` is written before any side effect, so post-crash forensics are possible.

## Tauri Shell — Supervisor and System Layer

### Startup orchestration (`main.rs`)

1. Acquire single-instance flock on `~/Library/Application Support/Vulture/lock`. On failure, focus the existing window and exit.
2. Initialize directories: `profiles/default/{agents,workspaces,permissions,conversations}`, `logs/`.
3. Generate token (32 bytes) and pick free ports: gateway from 4099, shell from 4199, scanning up to +100.
4. Start Shell's own HTTP server, wait for bind ready.
5. Atomically write `runtime.json` (`.tmp` then rename), mode 0600.
6. Spawn Bun Gateway child process with environment:
   - `VULTURE_GATEWAY_PORT`, `VULTURE_GATEWAY_TOKEN`
   - `VULTURE_SHELL_CALLBACK_URL=http://127.0.0.1:<shellPort>`
   - `VULTURE_SHELL_PID=<self-pid>`
   - `VULTURE_PROFILE_DIR=<profile-dir>`
7. Wait for Gateway to print `READY <port>` to stdout, max 5 seconds.
8. On timeout: kill child, log, transition supervisor to Restarting (counts toward backoff).
9. Start Tauri webview. UI fetches runtime descriptor via Tauri command.

### Restart policy

```text
backoff = [200ms, 1s, 5s, 30s]
max attempts = 4
reset rule: if process ran > 10 min healthily, attempts reset to 0
on max attempts: state → Faulted, UI shows fault page with Retry / Logs
```

On restart: token preserved (`runtime.json` unchanged), shell port preserved, gateway port re-picked (avoid TIME_WAIT), `runtime.json` re-written with new gateway port, UI notified via Tauri event `runtime-changed` to re-read and reconnect SSE.

### Run state on Gateway restart

In-memory active runs are lost; L0 does not persist run state for recovery. On Gateway startup, the runStore scans `runs WHERE status IN ('queued','running')` and marks them `failed` with `error.code = "internal.gateway_restarted"`. UI sees them as terminated runs. Persistence-based recovery is L1.

### Shutdown

Tauri exit:

1. Notify supervisor.
2. SIGTERM Gateway.
3. Wait 5 seconds. Gateway should reject new requests (503), close SSE streams with `run.failed(internal.shutdown)`, flush SQLite WAL, exit.
4. Otherwise SIGKILL.
5. Delete `runtime.json`.
6. Release single-instance flock.

Tauri crash (panic / segfault): `runtime.json` and the Gateway child are not cleaned synchronously. Mitigations:

- Gateway runs a watchdog timer (every 2s) checking that `VULTURE_SHELL_PID` is still alive. If not, Gateway exits.
- Next Tauri startup detects the lock file's PID is dead and reclaims.

### Tauri commands (system-level only after L0)

```text
get_runtime_info        -> RuntimeDescriptor
open_log_dir            -> ()
open_profile_dir        -> ()
get_supervisor_status   -> SupervisorStatus
restart_gateway         -> ()
pair_browser            -> ()
unpair_browser          -> ()
keychain_set            -> ()
keychain_get            -> Option<String>
```

All previous business commands (`list_agents`, `start_agent_run`, `save_agent`, etc.) are removed by phase 3.

### SupervisorStatus

```rust
enum SupervisorState {
    Starting,
    Running { since: Iso8601, pid: u32 },
    Restarting { attempt: u32, nextRetryAt: Iso8601, lastError: String },
    Faulted { reason: String, attemptCount: u32, lastError: String },
    Stopping,
}

struct SupervisorStatus {
    state: SupervisorState,
    gatewayLog: Option<String>,   // last N lines for first-fault debugging
}
```

UI in `Faulted` displays a fault page with the reason, "View Logs", "Retry" (resets attempt counter), "Quit" buttons.

### Failure modes

| Failure | System reaction | UI |
|---|---|---|
| Gateway not READY in 5s | supervisor → Restarting | "Gateway not started, retrying" |
| Restart attempts exhausted (4) | supervisor → Faulted | fault page + Retry / Logs |
| Gateway crashes after healthy run | restart (counter from 0) | brief "Reconnecting" + active run lost notice |
| Tauri panic | watchdog kills Gateway, orphan `runtime.json` | next start cleans up |
| Stale lock (PID dead) | claim it | normal startup |
| Live lock (other instance) | focus, exit | second instance does not start |
| All ports in 4099–4198 occupied | Tauri startup error | startup failure dialog |
| Keychain unavailable | LLM falls back to env var; both missing → UI prompts for setup | settings page |
| `runtime.json` write fails (disk full) | Tauri startup error | startup failure dialog |

## Migration Plan

Four phases, one PR per phase, no double-track. Phase N completion = old code deleted + new code live + UI on new path.

### Phase 1 — Infrastructure

Add Gateway lifecycle without touching business logic. Run still flows through old `apps/agent-sidecar` + `start_agent_run` Tauri command.

Add:

- `packages/protocol/src/v1/{runtime,error,index}.ts`
- `packages/common/src/{logger,result,ids}.ts`
- `crates/core/src/runtime.rs`
- `apps/desktop-shell/src/{supervisor,runtime,single_instance,tool_callback}.rs`
- `apps/desktop-shell/src/commands.rs` system commands
- `apps/gateway/` with `main.ts`, `server.ts`, `routes/healthz.ts`

Acceptance:

- App starts, `runtime.json` written 0600.
- Tauri exit cleans `runtime.json` and reaps Gateway.
- `curl /healthz` 200; other routes 401 without token.
- `kill -9 <gateway-pid>` triggers automatic restart through Restarting → Running.
- 4 failed restarts → Faulted; UI shows fault page.
- Second Tauri instance focuses the first and exits.
- `kill -9 <tauri-pid>` causes Gateway to self-exit within 4 seconds via watchdog.
- Old mock + `start_agent_run` paths still work.

Rollback: trivial — remove the supervisor invocation and the app degrades to its previous behavior.

### Phase 2 — Migrate Agent / Workspace / Profile CRUD

Move stores to Gateway SQLite, switch UI to HTTP, delete the old Tauri commands and file stores.

Add:

- `apps/gateway/src/persistence/{sqlite,migrate}.ts` + `migrations/001_init.sql`
- `apps/gateway/src/domain/{agent,workspace,profile}Store.ts`
- `apps/gateway/src/routes/{agents,workspaces,profile}.ts`
- `apps/desktop-ui/src/api/{client,agents,workspaces,profile}.ts`

Data migration (idempotent, runs every Gateway start): scan existing `${profileDir}/agents/*/{agent.json,instructions.md}` → insert into SQLite; rename old dir to `agents.bak.<timestamp>`. Same for workspaces and profile.

Bridge: the old sidecar (still used in phase 2) is modified to call the new `GET /v1/agents/:id` instead of reading files. This is the one tolerated double-track and is removed entirely in phase 3.

Delete:

- `apps/desktop-shell/src/{agent_store,workspace_store}.rs`
- All business commands in `commands.rs`
- `AppState` fields for stores

Acceptance:

- Old data migrates to SQLite; `.bak.*` directories present.
- UI agent CRUD goes via HTTP. Killing Gateway breaks UI ops (proves no fallback).
- `POST /v1/agents` without `Idempotency-Key` returns 400.
- Deleting the last agent returns 409.
- Old sidecar continues to run for runs (uses bridge to fetch agent from Gateway).
- All existing tests pass.

Rollback: technically possible but data must be exported from SQLite back to files. PR review treats this as risky.

### Phase 3 — Migrate Run / Conversation / Message; delete sidecar

Add:

- `apps/gateway/src/persistence/migrations/002_runs.sql` (conversations, messages, runs, run_events)
- `apps/gateway/src/domain/{conversation,message,run}Store.ts` with startup recovery sweep
- `apps/gateway/src/routes/{conversations,runs}.ts` with SSE
- `packages/agent-runtime/src/{runner,promptAssembler,events}.ts`
- `packages/llm/src/openai.ts` (or equivalent provider wrapper)
- `apps/gateway/agent-packs/local-work/` (moved from desktop-shell)
- `apps/desktop-shell/src/tool_callback.rs` filled in (invoke / cancel / manifest)
- `apps/desktop-ui/src/api/{conversations,runs}.ts` with SSE fetch client
- `apps/desktop-ui/src/components/{ConversationView,RunEventStream}`

UI rewrite: `App.tsx` evolves from "input box + run timeline" into a chat-like conversation view.

Delete:

- `apps/desktop-shell/src/{sidecar,agent_pack}.rs`
- `apps/desktop-shell/src/commands.rs::{start_agent_run,start_mock_run}`
- `apps/agent-sidecar/` (entire directory)
- `apps/desktop-shell/agent-packs/`
- `crates/core/src/agent.rs::AgentRecord`

Acceptance:

- UI sends a message → user message appears immediately → SSE streams tokens → tool calls render → completion.
- Network drop → reconnect with `Last-Event-ID` → no event loss.
- Killing Gateway mid-run → UI sees stream end → "Reconnecting" → that run marked `failed` → conversation continues afterwards.
- `crates/tool-gateway` audit shows `tool.requested` / `tool.completed` per call.
- `apps/agent-sidecar/` does not exist.
- `grep -r "start_agent_run" apps/` returns nothing (excluding docs).
- Browser tools: `browser.click` triggers `tool.ask` → UI approval flow → execution → run continues.

Rollback: not realistic. SQLite already holds conversations and messages with no path back to files. PR review must treat phase 3 as a one-way door (≥ 2 reviewers, second spec audit).

### Phase 4 — Cleanup, schema-sync CI, documentation

Add:

- `.github/workflows/protocol-check.yml` runs `openapi-typescript` and diffs against hand-written types; runs Rust ↔ TS round-trip test for `RuntimeDescriptor`.
- `apps/gateway/scripts/dev.ts` standalone dev launcher (faked runtime env) for backend-only iteration.
- `docs/architecture/{README,process-topology,protocol}.md` and `docs/architecture/contributing/adding-a-tool.md`.

Delete remaining dead code identified by `cargo machete` and `knip`. Trim `AppState` to supervisor + auth + browser pairing.

Acceptance:

- CI `protocol-check` job is green.
- A new contributor can read the docs and understand the architecture in ~30 minutes.
- `cargo machete` / `knip` report no dead code.

### Cross-phase constraints

1. One PR per phase with the acceptance checklist in the description.
2. Every phase passes CI before merge. No "merge now, fix tests later".
3. Phases 2 and 3 data migrations are tested on a throwaway profile first.
4. Phase 3 may internally split into 3a (Run/SSE backend) and 3b (UI rewrite), but still single-direction with no double-track.

## Testing Strategy

### Unit / integration

| Layer | Tests |
|---|---|
| `packages/protocol` | Type-only; tsc strict + brand round-trip test |
| `packages/common` | Util unit tests |
| `packages/llm` | Mock provider, thin wrapper |
| `packages/agent-runtime` | Runner state machine unit + integration with mocked LLM and mocked tool callback |
| `apps/gateway` domain stores | better-sqlite3 with tmp dir, full CRUD |
| `apps/gateway` routes | supertest-style HTTP integration with real SQLite + mocked LLM/Shell |
| SSE resume | Specific test: emit N events, simulate disconnect, reconnect with `Last-Event-ID`, assert receipt of (N+1..) |
| `crates/core` | Existing tests + `RuntimeDescriptor` Rust ↔ TS round-trip |
| `crates/tool-gateway` | Existing tests + axum app integration verifying policy is still enforced over HTTP |
| `apps/desktop-shell::supervisor` | Spawn fake child + verify restart / backoff / faulted state machine |
| `apps/desktop-shell::runtime` | runtime.json read/write + port selection + token strength |
| `apps/desktop-shell::tool_callback` | axum integration: tool invoke / approval / cancel |

### End-to-end

`tests/e2e/` driven by Playwright against the built app:

- `e2e-1` cold start: build, launch, new conversation, send "echo hello", expect SSE completion and reply.
- `e2e-2` Gateway fault recovery: start, kill Gateway via supervisor command, observe Restarting → Running, send another message, expect new run to succeed.
- `e2e-3` tool approval: trigger `browser.click`, approve, expect tool execution and run completion.
- `e2e-4` data migration (added at phase 2): seed legacy `agents/` directory, start app, verify SQLite contains migrated agent and `.bak` exists.

E2E tests use a temporary profile directory each run; no developer-environment pollution.

### Security

- `sec-1` Auth: missing token → 401; wrong token → 401; token in query string → 401 (explicit reject).
- `sec-2` Bind: `nc 0.0.0.0:<gatewayPort>` rejected; only `127.0.0.1` accepts.
- `sec-3` PID check: same token from a non-Gateway PID hitting `/tools/invoke` → 403.
- `sec-4` `runtime.json` permissions: stat after creation reports mode 0600.

### Out-of-scope tests

- Performance / load — L0 verifies shape; tuning is L1+.
- Multi-profile / multi-account — L0 is single-profile.
- LLM output quality — orthogonal to architecture.
- Long-running tools (> 60 s) — design supports them; L0 tests only up to ~5 s.

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| HTTP long connections terminated by OS / router | Medium | UI stream breaks | Last-Event-ID resume; large keepalive on Bun |
| `better-sqlite3` prebuilt missing or wrong version on macOS arm64 | Low | Gateway fails to start | CI matrix on macOS arm64 + x64; pinned versions |
| Bun child process cannot spawn from Tauri sandbox | Low | Architecture fails entirely | Spike in week 1 of phase 1 (mandatory) |
| Rust ↔ TS type drift | High | Silent bugs | Phase 4 protocol-check CI; review during phases 1–3 |
| SQLite WAL corruption on sudden kill | Low | Data loss | WAL + `SYNCHRONOUS=NORMAL`; `PRAGMA integrity_check` at startup |
| Token visible in `ps` env via Gateway args | Medium | Same-host user can steal | `env` not shown in `ps` on macOS; multi-user threat is out of scope |
| Multi-instance lock race | Low | Two Gateways start | flock instead of PID-file check |
| Bun cold start > 5s | Medium | UI startup slow / supervisor false alarm | Make 5s threshold configurable; macOS Gatekeeper first scan is slow |
| OpenAI Agents SDK ESM incompatibility on Bun | Medium | Runtime cannot run | Spike in phase 1 (mandatory) |
| Phase 3 is a one-way door | — | Wrong design discovered post-merge | ≥ 2 reviewers and second spec audit on phase 3 PR |

Mandatory pre-phase-1 spikes (≤ 1 day each):

1. Tauri can spawn a Bun child and capture stdio.
2. OpenAI Agents SDK runs a basic chat call on Bun 1.3.x.

Either failure halts L0 and triggers a re-brainstorm of substitutes (e.g. Node instead of Bun, or a different LLM library).

## Out of Scope (L0)

The following are deliberately not in L0. Each will get its own brainstorm → spec → plan cycle.

| Item | Tracked as |
|---|---|
| Skill system | L2 |
| Memory + vector store | L2 |
| MCP client | L3a |
| MCP server | L3a |
| PTY terminal | L3b |
| Chrome extension upgrade to CDP relay | L3c |
| Subagent / multi-agent orchestration | L4 |
| Multi-profile | L1+ |
| User accounts / cloud sync | Not planned (local-first product) |
| Run persistence and recovery | L1 |
| Token usage / cost tracking | L1 |
| Multimodal messages (images, files) | L1+ |
| Streaming pagination / history compaction | L1+ |
| Gateway running after Tauri exits | Not planned |
| CLI bringing up its own Gateway | Not planned |
| Remote external clients | Not planned (127.0.0.1 enforced) |
| HTTP/2 / gRPC / protobuf | Not planned |
| OpenAPI auto-codegen | L1 |
| Real RBAC / multi-user permissions | Not planned |
| Windows / Linux ports | Not planned, but no macOS-only APIs are written into shared code |

## Product Shape After L0

After L0, Vulture is a macOS desktop app. Opening the app starts a local Bun HTTP Gateway (port 4099+) that owns all agent / workspace / conversation / message / run data. The UI talks to the Gateway over HTTP/SSE, and tool execution is routed back through the Gateway to Tauri Rust (only Rust can actually run shell commands or operate the browser). Users can create agents, chat with them, see streaming responses, see tool-call progress, and approve sensitive tools. If the Gateway crashes it restarts automatically; old conversations remain but the in-flight run fails. None of Skill, Memory, MCP, or subagents exist yet — those are L1+ — but the package, type, and route namespaces are reserved for them.
