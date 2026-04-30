# Subagent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, inspectable subagent sessions backed by existing conversations and runs.

**Architecture:** Add a thin SQLite-backed `SubagentSessionStore` that records parent run/conversation metadata and points each child session at a normal conversation. Wire it into `sessions_*` local tools and add read-only routes for UI and harness inspection.

**Tech Stack:** Bun, Hono, bun:sqlite, Zod protocol schemas, existing gateway acceptance harness.

---

## File Structure

- Create `apps/gateway/src/persistence/migrations/013_subagent_sessions.sql`: schema and indexes.
- Modify `apps/gateway/src/persistence/migrate.ts`: load and apply migration 13.
- Modify `apps/gateway/src/persistence/migrate.test.ts`: assert latest schema and table shape.
- Create `apps/gateway/src/domain/subagentSessionStore.ts`: store, row mapping, status refresh.
- Create `apps/gateway/src/domain/subagentSessionStore.test.ts`: TDD coverage for create/list/get/status.
- Create `apps/gateway/src/routes/subagentSessions.ts`: read-only routes.
- Create `apps/gateway/src/routes/subagentSessions.test.ts`: route coverage.
- Modify `apps/gateway/src/runtime/gatewayLocalTools.ts`: pass full tool call into session handlers so they can infer parent run.
- Modify `apps/gateway/src/runtime/gatewayLocalTools.test.ts`: verify `sessions_*` receives run context.
- Modify `apps/gateway/src/server.ts`: instantiate store, wire routes and session tool behavior.
- Modify `apps/gateway/src/harness/acceptanceRunner.ts`: add subagent scenario steps.
- Modify `apps/gateway/src/harness/acceptanceSuite.ts`: add spawn/yield/history scenario.
- Modify `apps/gateway/src/harness/acceptanceSuite.test.ts`: assert scenario is registered.

## Task 1: Migration

**Files:**
- Create: `apps/gateway/src/persistence/migrations/013_subagent_sessions.sql`
- Modify: `apps/gateway/src/persistence/migrate.ts`
- Modify: `apps/gateway/src/persistence/migrate.test.ts`

- [ ] **Step 1: Write failing migration test**

Add a test that expects schema version 13 and a `subagent_sessions` table with:
`id`, `parent_conversation_id`, `parent_run_id`, `agent_id`, `conversation_id`,
`label`, `status`, `message_count`, `created_at`, `updated_at`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/gateway/src/persistence/migrate.test.ts`
Expected: FAIL because latest schema is still 12 and table is missing.

- [ ] **Step 3: Add migration and loader**

Create migration 13 with the table and indexes on parent conversation, parent
run, child conversation, and status. Load it in `migrate.ts` and update
`LATEST_SCHEMA_VERSION` to 13.

- [ ] **Step 4: Verify migration test passes**

Run: `bun test apps/gateway/src/persistence/migrate.test.ts`
Expected: PASS.

## Task 2: Subagent Session Store

**Files:**
- Create: `apps/gateway/src/domain/subagentSessionStore.ts`
- Create: `apps/gateway/src/domain/subagentSessionStore.test.ts`

- [ ] **Step 1: Write failing store tests**

Cover:
- `create` stores parent conversation/run, child conversation, label, and status.
- `list` filters by parent conversation/run/agent and applies limit.
- `getByConversationId` maps a child conversation back to its session.
- `refreshStatus` derives `active`, `completed`, `failed`, and `cancelled` from child runs.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/gateway/src/domain/subagentSessionStore.test.ts`
Expected: FAIL because the store file does not exist.

- [ ] **Step 3: Implement store**

Use existing `ConversationStore`, `RunStore`, and `MessageStore` outputs. Store
rows in SQLite; compute status from `RunStore.listForConversation`, and use
`MessageStore.listSince` for message counts.

- [ ] **Step 4: Verify store test passes**

Run: `bun test apps/gateway/src/domain/subagentSessionStore.test.ts`
Expected: PASS.

## Task 3: Read-Only Routes

**Files:**
- Create: `apps/gateway/src/routes/subagentSessions.ts`
- Create: `apps/gateway/src/routes/subagentSessions.test.ts`
- Modify: `apps/gateway/src/server.ts`

- [ ] **Step 1: Write failing route tests**

Cover:
- `GET /v1/subagent-sessions` returns filtered sessions.
- `GET /v1/subagent-sessions/:id` returns one session or 404.
- `GET /v1/subagent-sessions/:id/messages` returns child conversation messages.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/gateway/src/routes/subagentSessions.test.ts`
Expected: FAIL because route module does not exist.

- [ ] **Step 3: Implement routes and server wiring**

Build a Hono router with read-only endpoints and register it from `buildServer`.

- [ ] **Step 4: Verify route tests pass**

Run: `bun test apps/gateway/src/routes/subagentSessions.test.ts`
Expected: PASS.

## Task 4: Tool Semantics

**Files:**
- Modify: `apps/gateway/src/runtime/gatewayLocalTools.ts`
- Modify: `apps/gateway/src/runtime/gatewayLocalTools.test.ts`
- Modify: `apps/gateway/src/server.ts`

- [ ] **Step 1: Write failing local-tool tests**

Assert session handlers receive the full call context, including `runId`,
`callId`, `workspacePath`, and input. Assert `sessions_send` can target
`sessionId`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/gateway/src/runtime/gatewayLocalTools.test.ts`
Expected: FAIL because handlers currently only receive raw input.

- [ ] **Step 3: Update local tool handler interfaces**

Change `GatewaySessionsTools` handlers to receive the full tool call. Keep the
public tool names and approval behavior unchanged.

- [ ] **Step 4: Implement server session behavior**

Use `RunStore.get(call.runId)` to find parent conversation. In `sessions_spawn`,
create the child conversation, create a subagent session, optionally start a run,
and return `{ session, conversation, runId }`. In `sessions_send`, resolve
`sessionId` to conversation id and update the session after sending. In
`sessions_list`, `sessions_history`, and `sessions_yield`, support `sessionId`
and parent filters.

- [ ] **Step 5: Verify local-tool tests pass**

Run: `bun test apps/gateway/src/runtime/gatewayLocalTools.test.ts`
Expected: PASS.

## Task 5: Acceptance Harness

**Files:**
- Modify: `apps/gateway/src/harness/acceptanceRunner.ts`
- Modify: `apps/gateway/src/harness/acceptanceSuite.ts`
- Modify: `apps/gateway/src/harness/acceptanceSuite.test.ts`

- [ ] **Step 1: Write failing harness tests**

Register a scenario `subagent-spawn-yield-history` and add runner steps for
read-only subagent API calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/gateway/src/harness/acceptanceSuite.test.ts`
Expected: FAIL because the scenario does not exist.

- [ ] **Step 3: Implement acceptance step support**

Add steps to list sessions, fetch messages, and assert parent/child session
fields. Keep scenario deterministic by seeding session state or using gateway
stub behavior.

- [ ] **Step 4: Verify harness tests pass**

Run: `bun test apps/gateway/src/harness/acceptanceSuite.test.ts`
Expected: PASS.

## Task 6: Full Verification

**Files:**
- No new files expected.

- [ ] **Step 1: Run focused gateway tests**

Run:
`bun test apps/gateway/src/persistence/migrate.test.ts apps/gateway/src/domain/subagentSessionStore.test.ts apps/gateway/src/routes/subagentSessions.test.ts apps/gateway/src/runtime/gatewayLocalTools.test.ts apps/gateway/src/harness/acceptanceSuite.test.ts`

- [ ] **Step 2: Run typecheck**

Run: `bun --filter @vulture/gateway typecheck`

- [ ] **Step 3: Run harness lanes**

Run:
`bun run harness:runtime`
`bun run harness:tools`
`bun run harness:acceptance -- --scenario subagent-spawn-yield-history`

- [ ] **Step 4: Commit**

Stage only files touched by this feature. Do not stage unrelated `.artifacts/`
or `apps/desktop-e2e/` unless explicitly requested.
