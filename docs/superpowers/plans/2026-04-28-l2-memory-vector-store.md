# L2 Memory + Vector Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local per-agent memories that can be manually managed and injected into run context.

**Architecture:** Gateway owns memory persistence, embedding/keyword indexing, retrieval, and run-context formatting. Desktop UI uses typed API helpers and replaces the Settings memory placeholder with manual memory management. Retrieval is best-effort and never blocks a run when memory search fails.

**Tech Stack:** Bun, Hono, SQLite, React, OpenAI embeddings via fetch when configured.

---

### Task 1: Gateway Persistence

**Files:**
- Create: `apps/gateway/src/persistence/migrations/007_memories.sql`
- Modify: `apps/gateway/src/persistence/migrate.ts`
- Modify: `apps/gateway/src/persistence/migrate.test.ts`
- Create: `apps/gateway/src/domain/memoryStore.ts`
- Create: `apps/gateway/src/domain/memoryStore.test.ts`

- [ ] Add migration and a failing migration test for `memories`.
- [ ] Add `MemoryStore` tests for create/list/delete per agent.
- [ ] Implement migration wiring and store methods.
- [ ] Run `bun test apps/gateway/src/persistence/migrate.test.ts apps/gateway/src/domain/memoryStore.test.ts`.

### Task 2: Gateway Retrieval + Formatting

**Files:**
- Create: `apps/gateway/src/runtime/memoryRetrieval.ts`
- Create: `apps/gateway/src/runtime/memoryRetrieval.test.ts`

- [ ] Add failing tests for keyword fallback, embedding cosine ranking, and XML formatting.
- [ ] Implement token normalization, cosine scoring, top-k retrieval, and `<memories>` formatting.
- [ ] Run `bun test apps/gateway/src/runtime/memoryRetrieval.test.ts`.

### Task 3: Gateway Routes + Run Context

**Files:**
- Create: `apps/gateway/src/routes/memories.ts`
- Create: `apps/gateway/src/routes/memories.test.ts`
- Modify: `apps/gateway/src/routes/runs.ts`
- Modify: `apps/gateway/src/routes/runs.test.ts`
- Modify: `apps/gateway/src/server.ts`

- [ ] Add failing route tests for list/create/delete.
- [ ] Add failing run-route test proving memories and skills are combined in `contextPrompt`.
- [ ] Register `MemoryStore` and `memoriesRouter` in `server.ts`.
- [ ] Add `memoryPromptForRun` dependency to `runsRouter`.
- [ ] Run route tests.

### Task 4: Desktop API + Settings UI

**Files:**
- Create: `apps/desktop-ui/src/api/memories.ts`
- Modify: `apps/desktop-ui/src/chat/SettingsPage.tsx`
- Modify: `apps/desktop-ui/src/App.tsx`
- Modify: `apps/desktop-ui/src/App.integration.test.tsx`

- [ ] Add failing integration test for Memory settings list/add/delete.
- [ ] Implement typed API helper.
- [ ] Replace Memory placeholder with manual management panel.
- [ ] Run targeted desktop integration test.

### Task 5: Verification

- [ ] Run `bun test apps/gateway/src`.
- [ ] Run `bun test apps/desktop-ui/src`.
- [ ] Run `bun --filter @vulture/gateway typecheck`.
- [ ] Run `bun --filter @vulture/desktop-ui typecheck`.
- [ ] Run `git diff --check`.

