# Subagent Orchestration Design

Date: 2026-04-30

## Goal

Add first-class subagent orchestration to Vulture without turning the product
into a full team-chat system. The first phase should make delegated agent work
durable, inspectable, recoverable, and usable by tools through the existing
OpenAI Agents SDK runtime path.

## Context

Vulture already has conversations, runs, run recovery, approval, tool
contracts, core `sessions_*` tools, Agent management, Skill management, Memory,
MCP client support, and harness lanes. The current `sessions_*` tools can create
or message conversations, but they do not preserve parent-child semantics. A
parent agent cannot reliably answer which child sessions it started, which child
runs are active, or what changed after a restart.

Accio's local data shows a useful shape to absorb: a subagent session store with
a stable session key, parent session key, agent id, status, label, message
count, and message history. Vulture should adapt that idea to its existing
SQLite conversation/run model rather than introducing a separate message store.

## Non-Goals

- Do not build a full group-chat UI in this phase.
- Do not add automatic subagent spawning by the model outside explicit tool use.
- Do not rewrite the run orchestrator or replace existing recovery behavior.
- Do not add remote/cloud subagents.
- Do not add complex scheduling, priority queues, or worker pools.

## Architecture

The first phase adds a thin `SubagentSessionStore` on top of existing
conversations and runs. Each subagent session points to a real conversation, so
messages, events, recovery, token usage, approvals, and attachments continue to
flow through the current system.

```text
parent conversation
  parent run
    tool: sessions_spawn
      subagent session
        child conversation
          child run(s)
```

The parent-child relationship is durable metadata. Runtime execution remains
owned by `startConversationRun` and `orchestrateRun`.

## Data Model

Add a migration for `subagent_sessions`:

```text
id                     TEXT PRIMARY KEY
parent_conversation_id TEXT NOT NULL
parent_run_id          TEXT NOT NULL
agent_id               TEXT NOT NULL
conversation_id        TEXT NOT NULL
label                  TEXT NOT NULL
status                 TEXT NOT NULL
message_count          INTEGER NOT NULL
created_at             TEXT NOT NULL
updated_at             TEXT NOT NULL
```

Status values:

- `active`: at least one child run is queued, running, or recoverable.
- `completed`: child work has no active run and at least one successful
  assistant result exists.
- `failed`: latest child run failed.
- `cancelled`: latest child run was cancelled.

The store computes status from child runs when possible and persists an updated
status after session actions. This keeps list queries cheap while avoiding a
second source of truth for message content.

## Tool Semantics

Existing tool names stay stable.

`sessions_spawn`

- Requires approval, as today.
- Creates a child conversation for the requested `agentId` or the default local
  work agent.
- Records a subagent session linked to the current tool call's `runId` and the
  parent run's conversation.
- Accepts optional `title`, `label`, and `message`.
- If `message` is present, starts a child run through the same start-run path as
  normal chat.
- Returns `session`, `conversation`, and `runId`.

`sessions_send`

- Requires approval, as today.
- Accepts either `sessionId` or `conversationId`.
- Starts another run in the child conversation.
- Updates `messageCount` and session status when a known subagent session is
  targeted.

`sessions_list`

- Safe/idempotent.
- Supports optional filters for `parentConversationId`, `parentRunId`,
  `agentId`, and `limit`.
- By default, when called during a run, returns sessions spawned by the active
  parent conversation first.

`sessions_history`

- Safe/idempotent.
- Accepts either `sessionId` or `conversationId`.
- Returns recent messages from the linked conversation.

`sessions_yield`

- Safe/idempotent.
- Returns active child runs for the current parent run/conversation, plus a
  compact list of recently completed/failed child sessions.
- This is the parent agent's polling primitive after delegation.

## API Surface

Add gateway routes for UI and harness inspection:

- `GET /v1/subagent-sessions`
- `GET /v1/subagent-sessions/:id`
- `GET /v1/subagent-sessions/:id/messages`

The first route accepts the same filters as `sessions_list`. These routes are
read-only in phase one; mutation goes through tools so approval and run context
remain explicit.

## UI Scope

Phase one only makes subagent activity visible enough for manual validation:

- Tool blocks already show `sessions_spawn`, `sessions_send`, and
  `sessions_yield` outputs.
- No dedicated multi-agent panel is required in this phase.
- If a later UI panel is added, it should consume the read-only
  `/v1/subagent-sessions` routes rather than parsing tool output.

## Recovery

Because each child task is a normal conversation run, existing run recovery
continues to apply. Gateway restart must not break the subagent relationship:

- The subagent session row survives restart.
- Active child runs still appear through `sessions_yield`.
- Recoverable child runs remain recoverable through existing run APIs.

No automatic replay of non-idempotent `sessions_spawn` or `sessions_send` is
introduced.

## Testing And Harness

Add focused tests before implementation:

- Store tests for create/list/get/status refresh.
- Gateway local tool tests for `sessionId` support and parent-run scoping.
- Route tests for read-only subagent session APIs.
- Acceptance scenario for spawn -> yield -> history.
- Recovery scenario proving the subagent relationship survives gateway rebuild.
- Tool contract expectations stay unchanged for approval and idempotency.

## Acceptance Criteria

- `sessions_spawn` creates a durable subagent session linked to the parent run.
- `sessions_send` can target a child by `sessionId`.
- `sessions_list` and `sessions_yield` expose child session state without
  relying on tool output parsing.
- Existing conversation/run recovery behavior remains unchanged.
- `bun run harness:ci` remains green.
- Manual validation can spawn a subagent, inspect it through tool output, and
  confirm it still exists after gateway restart.
