# Subagent Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subagent work visible in Chat and make completed child results easy for the parent agent to recover and integrate.

**Architecture:** Extend the existing `subagent_sessions` record with product-facing task/result metadata, keep child work as normal conversations/runs, and expose result groups through `sessions_yield`. The Chat UI continues to read subagent data from read-only APIs rather than parsing tool blocks.

**Tech Stack:** Bun, TypeScript, SQLite migrations, Hono routes, React, `@testing-library/react`, Vulture runtime/tool/acceptance harnesses.

---

## File Structure

- Modify `apps/gateway/src/persistence/migrations/015_subagent_productization.sql`
  - Adds metadata columns to `subagent_sessions`.
- Modify `apps/gateway/src/domain/subagentSessionStore.ts`
  - Owns title/task/result metadata, terminal status refresh, and result extraction.
- Modify `apps/gateway/src/domain/subagentSessionStore.test.ts`
  - Store-level TDD for metadata persistence and terminal result summaries.
- Modify `apps/gateway/src/server/localTools.ts`
  - Stores spawn metadata and returns `sessions_yield` grouped as `active`, `completed`, `failed`.
- Modify `apps/gateway/src/runtime/gatewayLocalTools.test.ts`
  - Verifies local tool passthrough shape for grouped yield output.
- Modify `apps/gateway/src/routes/subagentSessions.test.ts`
  - Verifies route payloads include product metadata.
- Modify `packages/agent-runtime/src/promptAssembler.ts`
  - Tightens manager-pattern guidance around title/message/yield/final integration.
- Modify `packages/agent-runtime/src/promptAssembler.test.ts`
  - Tests prompt guidance.
- Modify `apps/desktop-ui/src/api/subagentSessions.ts`
  - Adds UI DTO fields.
- Modify `apps/desktop-ui/src/api/subagentSessions.test.ts`
  - Tests DTO-compatible API usage.
- Modify `apps/desktop-ui/src/chat/SubagentSessionPanel.tsx`
  - Turns the panel into a subtask status section.
- Modify `apps/desktop-ui/src/chat/SubagentSessionPanel.test.tsx`
  - Tests task/result/failure display and expansion.
- Modify `apps/gateway/src/harness/runtimeHarness.ts`
  - Adds a spawn -> yield -> final result recovery scenario.
- Modify `apps/gateway/src/harness/runtimeHarness.test.ts`
  - Tests the new scenario.
- Modify `apps/gateway/src/harness/acceptanceSuite.ts`
  - Adds/updates a product scenario for spawn -> completed child -> yield -> final answer.
- Modify `apps/gateway/src/harness/acceptanceRunner.ts`
  - Extends the seeded subagent helper/assertions to include metadata and result summary.
- Modify `apps/gateway/src/harness/acceptanceRunner.test.ts`
  - Tests the acceptance scenario.

## Task 1: Persist Subagent Task And Result Metadata

**Files:**
- Create: `apps/gateway/src/persistence/migrations/015_subagent_productization.sql`
- Modify: `apps/gateway/src/domain/subagentSessionStore.ts`
- Test: `apps/gateway/src/domain/subagentSessionStore.test.ts`

- [ ] **Step 1: Write failing store tests for task metadata**

Add this test inside `describe("SubagentSessionStore", ...)` in `apps/gateway/src/domain/subagentSessionStore.test.ts`:

```ts
test("create stores product-facing title and task metadata", () => {
  const stores = fresh();
  const session = stores.sessions.create({
    parentConversationId: stores.parent.id,
    parentRunId: stores.parentRun.id,
    agentId: stores.child.agentId,
    conversationId: stores.child.id,
    label: "Research docs",
    title: "Research SDK docs",
    task: "Read the Agents SDK orchestration docs and summarize the useful bits.",
  });

  expect(session).toMatchObject({
    label: "Research docs",
    title: "Research SDK docs",
    task: "Read the Agents SDK orchestration docs and summarize the useful bits.",
    resultSummary: null,
    resultMessageId: null,
    completedAt: null,
    lastError: null,
  });
  expect(stores.sessions.get(session.id)).toMatchObject({
    title: "Research SDK docs",
    task: "Read the Agents SDK orchestration docs and summarize the useful bits.",
  });
  stores.cleanup();
});
```

- [ ] **Step 2: Write failing store tests for terminal result summaries**

Add this test after the existing status tests in `apps/gateway/src/domain/subagentSessionStore.test.ts`:

```ts
test("refreshStatus captures completed result summary and keeps completedAt stable", () => {
  const stores = fresh();
  const session = stores.sessions.create({
    parentConversationId: stores.parent.id,
    parentRunId: stores.parentRun.id,
    agentId: stores.child.agentId,
    conversationId: stores.child.id,
    label: "Worker",
    title: "Inspect docs",
    task: "Find the relevant details.",
  });
  const childMessage = stores.messages.append({
    conversationId: stores.child.id,
    role: "user",
    content: "go",
    runId: null,
  });
  const childRun = stores.runs.create({
    conversationId: stores.child.id,
    agentId: stores.child.agentId,
    triggeredByMessageId: childMessage.id,
  });
  const result = stores.messages.append({
    conversationId: stores.child.id,
    role: "assistant",
    content: "The child result contains the important detail.",
    runId: childRun.id,
  });
  stores.runs.markSucceeded(childRun.id, result.id);

  const completed = stores.sessions.refreshStatus(session.id);
  expect(completed).toMatchObject({
    status: "completed",
    resultSummary: "The child result contains the important detail.",
    resultMessageId: result.id,
  });
  expect(completed?.completedAt).toBeTruthy();

  const completedAt = completed?.completedAt;
  expect(stores.sessions.refreshStatus(session.id)?.completedAt).toBe(completedAt);
  stores.cleanup();
});

test("refreshStatus captures failure errors", () => {
  const stores = fresh();
  const session = stores.sessions.create({
    parentConversationId: stores.parent.id,
    parentRunId: stores.parentRun.id,
    agentId: stores.child.agentId,
    conversationId: stores.child.id,
    label: "Worker",
  });
  const childMessage = stores.messages.append({
    conversationId: stores.child.id,
    role: "user",
    content: "go",
    runId: null,
  });
  const childRun = stores.runs.create({
    conversationId: stores.child.id,
    agentId: stores.child.agentId,
    triggeredByMessageId: childMessage.id,
  });
  stores.runs.markFailed(childRun.id, { code: "internal", message: "child exploded" });

  expect(stores.sessions.refreshStatus(session.id)).toMatchObject({
    status: "failed",
    lastError: "child exploded",
  });
  stores.cleanup();
});
```

- [ ] **Step 3: Run the failing store tests**

Run:

```bash
bun test apps/gateway/src/domain/subagentSessionStore.test.ts
```

Expected: FAIL because `CreateSubagentSessionInput` and `SubagentSession` do not have `title`, `task`, `resultSummary`, `resultMessageId`, `completedAt`, or `lastError`.

- [ ] **Step 4: Add migration 015**

Create `apps/gateway/src/persistence/migrations/015_subagent_productization.sql`:

```sql
ALTER TABLE subagent_sessions ADD COLUMN title TEXT;
ALTER TABLE subagent_sessions ADD COLUMN task TEXT;
ALTER TABLE subagent_sessions ADD COLUMN result_summary TEXT;
ALTER TABLE subagent_sessions ADD COLUMN result_message_id TEXT;
ALTER TABLE subagent_sessions ADD COLUMN completed_at TEXT;
ALTER TABLE subagent_sessions ADD COLUMN last_error TEXT;

INSERT OR IGNORE INTO schema_version(version) VALUES (15);
```

- [ ] **Step 5: Extend store types and row mapping**

In `apps/gateway/src/domain/subagentSessionStore.ts`, update the interfaces:

```ts
export interface SubagentSession {
  id: string;
  parentConversationId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  label: string;
  title: string | null;
  task: string | null;
  status: SubagentSessionStatus;
  messageCount: number;
  resultSummary: string | null;
  resultMessageId: string | null;
  completedAt: Iso8601 | null;
  lastError: string | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface CreateSubagentSessionInput {
  parentConversationId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  label: string;
  title?: string | null;
  task?: string | null;
  status?: SubagentSessionStatus;
}
```

Extend `SubagentSessionRow` and `rowToSession()`:

```ts
interface SubagentSessionRow {
  id: string;
  parent_conversation_id: string;
  parent_run_id: string;
  agent_id: string;
  conversation_id: string;
  label: string;
  title: string | null;
  task: string | null;
  status: string;
  message_count: number;
  result_summary: string | null;
  result_message_id: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
```

```ts
function rowToSession(row: SubagentSessionRow): SubagentSession {
  return {
    id: row.id,
    parentConversationId: row.parent_conversation_id,
    parentRunId: row.parent_run_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    label: row.label,
    title: row.title,
    task: row.task,
    status: normalizeStatus(row.status),
    messageCount: row.message_count,
    resultSummary: row.result_summary,
    resultMessageId: row.result_message_id,
    completedAt: row.completed_at as Iso8601 | null,
    lastError: row.last_error,
    createdAt: row.created_at as Iso8601,
    updatedAt: row.updated_at as Iso8601,
  };
}
```

- [ ] **Step 6: Persist metadata in create()**

Update the `INSERT` in `create()`:

```ts
this.db
  .query(
    `INSERT INTO subagent_sessions(
       id, parent_conversation_id, parent_run_id, agent_id, conversation_id,
       label, title, task, status, message_count, result_summary,
       result_message_id, completed_at, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    id,
    input.parentConversationId,
    input.parentRunId,
    input.agentId,
    input.conversationId,
    input.label,
    normalizeOptionalText(input.title),
    normalizeOptionalText(input.task),
    input.status ?? "active",
    messageCount,
    null,
    null,
    null,
    null,
    now,
    now,
  );
```

Add helper near `genId()`:

```ts
function normalizeOptionalText(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}
```

- [ ] **Step 7: Populate terminal metadata in refreshStatus()**

Add helper types and methods in `SubagentSessionStore`:

```ts
interface TerminalMetadata {
  resultSummary: string | null;
  resultMessageId: string | null;
  completedAt: Iso8601 | null;
  lastError: string | null;
}
```

Inside `refreshStatus()`, replace the current update with:

```ts
const status = this.deriveStatus(session.conversationId);
const messageCount = this.countMessages(session.conversationId);
const now = nowIso8601();
const terminal = this.terminalMetadata(session, status, now);
this.db
  .query(
    `UPDATE subagent_sessions
     SET status = ?, message_count = ?, result_summary = ?, result_message_id = ?,
         completed_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  )
  .run(
    status,
    messageCount,
    terminal.resultSummary,
    terminal.resultMessageId,
    terminal.completedAt,
    terminal.lastError,
    now,
    id,
  );
```

Add methods:

```ts
private terminalMetadata(
  session: SubagentSession,
  status: SubagentSessionStatus,
  now: Iso8601,
): TerminalMetadata {
  if (status === "active") {
    return {
      resultSummary: session.resultSummary,
      resultMessageId: session.resultMessageId,
      completedAt: session.completedAt,
      lastError: null,
    };
  }
  if (status === "completed") {
    const result = this.latestAssistantMessage(session.conversationId);
    return {
      resultSummary: result ? summarizeSubagentResult(result.content) : session.resultSummary,
      resultMessageId: result?.id ?? session.resultMessageId,
      completedAt: session.completedAt ?? now,
      lastError: null,
    };
  }
  return {
    resultSummary: session.resultSummary,
    resultMessageId: session.resultMessageId,
    completedAt: session.completedAt ?? now,
    lastError: this.latestRunError(session.conversationId) ?? status,
  };
}

private latestAssistantMessage(conversationId: string) {
  return [...this.deps.messages.listSince({ conversationId })]
    .reverse()
    .find((message) => message.role === "assistant") ?? null;
}

private latestRunError(conversationId: string): string | null {
  const latest = this.deps.runs.listForConversation(conversationId)[0];
  return latest?.error?.message ?? null;
}
```

Add top-level helper:

```ts
export function summarizeSubagentResult(content: string, maxLength = 360): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}
```

- [ ] **Step 8: Run store tests**

Run:

```bash
bun test apps/gateway/src/domain/subagentSessionStore.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src/persistence/migrations/015_subagent_productization.sql apps/gateway/src/domain/subagentSessionStore.ts apps/gateway/src/domain/subagentSessionStore.test.ts
git commit -m "Add subagent task result metadata"
```

## Task 2: Return Productized `sessions_spawn` And `sessions_yield` Results

**Files:**
- Modify: `apps/gateway/src/server/localTools.ts`
- Modify: `apps/gateway/src/runtime/gatewayLocalTools.test.ts`
- Modify: `packages/agent-runtime/src/promptAssembler.ts`
- Test: `packages/agent-runtime/src/promptAssembler.test.ts`

- [ ] **Step 1: Write failing local tool test for grouped yield passthrough**

In `apps/gateway/src/runtime/gatewayLocalTools.test.ts`, extend the existing `"sessions and update_plan use gateway stores when provided"` test after `sessions_send`:

```ts
await expect(
  tools({
    callId: "c-session-yield",
    runId: "r-parent",
    tool: "sessions_yield",
    workspacePath,
    input: { limit: 20 },
  }),
).resolves.toMatchObject({
  active: [],
  completed: [{ sessionId: "sub-1", resultSummary: "child result" }],
  failed: [],
});
```

Change the stubbed `yield` implementation in that test to:

```ts
yield: (call) => {
  seenCalls.push({ tool: "sessions_yield", runId: call.runId, input: call.input });
  return {
    active: [],
    completed: [{ sessionId: "sub-1", resultSummary: "child result" }],
    failed: [],
  };
},
```

- [ ] **Step 2: Run the local tool test**

Run:

```bash
bun test apps/gateway/src/runtime/gatewayLocalTools.test.ts --test-name-pattern "sessions and update_plan"
```

Expected: PASS if passthrough already works. This locks the expected grouped result shape at the local-tool boundary.

- [ ] **Step 3: Write failing tests for localTools session metadata**

Add this test inside the existing `describe("createGatewayServerLocalTools", ...)` block in `apps/gateway/src/server/localTools.test.ts`. It reuses the file's existing `freshCfg()`, `createGatewayStores()`, and imports:

```ts
test("sessions_spawn stores title/task and sessions_yield groups completed results", async () => {
  const { cfg, cleanup } = freshCfg();
  try {
    const { stores } = createGatewayStores({ cfg });
    const parentConversation = stores.conversationStore.create({
      agentId: "local-work-agent",
      title: "Parent",
    });
    const parentMessage = stores.messageStore.append({
      conversationId: parentConversation.id,
      role: "user",
      content: "start",
      runId: null,
    });
    const parentRun = stores.runStore.create({
      conversationId: parentConversation.id,
      agentId: "local-work-agent",
      triggeredByMessageId: parentMessage.id,
    });
    const tools = createGatewayServerLocalTools({
      stores,
      shellTools: async () => {
        throw new Error("shell should not be called");
      },
      mcp: {
        canHandle: () => false,
        execute: async () => undefined,
      },
      runtimeHooks: () => undefined,
      startConversationRun: async (conversationId, input) => {
        const message = stores.messageStore.append({
          conversationId,
          role: "user",
          content: input,
          runId: null,
        });
        const run = stores.runStore.create({
          conversationId,
          agentId: stores.conversationStore.get(conversationId)?.agentId ?? "local-work-agent",
          triggeredByMessageId: message.id,
        });
        stores.runStore.markRunning(run.id);
        return { conversationId, runId: run.id, messageId: message.id };
      },
    });

    const spawned = await tools({
      callId: "c-spawn",
      runId: parentRun.id,
      tool: "sessions_spawn",
      workspacePath: cfg.profileDir,
      approvalToken: "approved",
      input: {
        agentId: "local-work-agent",
        title: "Inspect docs",
        label: "Docs worker",
        message: "Read the docs and return the useful part.",
      },
    }) as {
      runId: string;
      session: { id: string; title: string; task: string; conversationId: string };
    };

    expect(spawned.session).toMatchObject({
      title: "Inspect docs",
      task: "Read the docs and return the useful part.",
    });

    const result = stores.messageStore.append({
      conversationId: spawned.session.conversationId,
      role: "assistant",
      content: "Useful part found.",
      runId: spawned.runId,
    });
    stores.runStore.markSucceeded(spawned.runId, result.id);

    const yielded = await tools({
      callId: "c-yield",
      runId: parentRun.id,
      tool: "sessions_yield",
      workspacePath: cfg.profileDir,
      input: { limit: 20 },
    });

    expect(yielded).toMatchObject({
      active: [],
      completed: [{ sessionId: spawned.session.id, resultSummary: "Useful part found." }],
      failed: [],
    });
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 4: Run the failing server local tools test**

Run:

```bash
bun test apps/gateway/src/server/localTools.test.ts
```

Expected: FAIL until `spawn` stores metadata and `yield` returns grouped result lists.

- [ ] **Step 5: Store title/task in sessions_spawn**

In `apps/gateway/src/server/localTools.ts`, update `spawn`:

```ts
const title = typeof value.title === "string" ? value.title.trim() : "";
const task = typeof value.message === "string" ? value.message.trim() : "";
const conversation = conversationStore.create({
  agentId,
  title: title || task.slice(0, 40) || agentId,
});
const label = subagentLabel(value, title, agentId);
const session = subagentSessionStore.create({
  parentConversationId: parentRun.conversationId,
  parentRunId: parentRun.id,
  agentId,
  conversationId: conversation.id,
  label,
  title: title || label,
  task,
});
```

- [ ] **Step 6: Group sessions_yield output**

In the `yield` implementation in `apps/gateway/src/server/localTools.ts`, replace the return block with:

```ts
const items = sessions.map((session) => ({
  ...session,
  sessionId: session.id,
  activeRuns: runStore.listForConversation(session.conversationId, { status: "active" }),
}));
const active = items.filter((session) => session.status === "active");
const completed = items
  .filter((session) => session.status === "completed")
  .map(sessionYieldSummary);
const failed = items
  .filter((session) => session.status === "failed" || session.status === "cancelled")
  .map(sessionYieldSummary);
return {
  items,
  active,
  completed,
  failed,
  activeRuns: active.flatMap((session) => session.activeRuns),
};
```

Add helper below `subagentLabel()`:

```ts
function sessionYieldSummary(session: {
  id: string;
  agentId: string;
  title: string | null;
  task: string | null;
  label: string;
  status: string;
  resultSummary: string | null;
  lastError: string | null;
}) {
  return {
    sessionId: session.id,
    agentId: session.agentId,
    title: session.title ?? session.label,
    task: session.task,
    status: session.status,
    resultSummary: session.resultSummary,
    lastError: session.lastError,
  };
}
```

- [ ] **Step 7: Tighten prompt guidance**

In `packages/agent-runtime/src/promptAssembler.ts`, update `formatHandoffs()` to include these lines:

```ts
"Treat subagents as specialist tools: you remain responsible for the final user-facing answer.",
"`sessions_spawn.title` must be a short user-readable task name, and `sessions_spawn.message` must be a complete task brief.",
"After a child task can complete, call `sessions_yield` to recover completed or failed child results before writing the final answer.",
"Integrate completed child results into your final answer in your normal assistant voice; do not expose raw internal metadata.",
```

- [ ] **Step 8: Update prompt tests**

In `packages/agent-runtime/src/promptAssembler.test.ts`, update the handoff test to assert:

```ts
expect(text).toContain("Treat subagents as specialist tools");
expect(text).toContain("sessions_spawn.title");
expect(text).toContain("sessions_yield");
expect(text).toContain("final user-facing answer");
```

- [ ] **Step 9: Run tests**

Run:

```bash
bun test apps/gateway/src/runtime/gatewayLocalTools.test.ts apps/gateway/src/server/localTools.test.ts packages/agent-runtime/src/promptAssembler.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/gateway/src/server/localTools.ts apps/gateway/src/server/localTools.test.ts apps/gateway/src/runtime/gatewayLocalTools.test.ts packages/agent-runtime/src/promptAssembler.ts packages/agent-runtime/src/promptAssembler.test.ts
git commit -m "Productize subagent yield results"
```

## Task 3: Surface Subtask Metadata Through API And Chat UI

**Files:**
- Modify: `apps/gateway/src/routes/subagentSessions.test.ts`
- Modify: `apps/desktop-ui/src/api/subagentSessions.ts`
- Modify: `apps/desktop-ui/src/api/subagentSessions.test.ts`
- Modify: `apps/desktop-ui/src/chat/SubagentSessionPanel.tsx`
- Modify: `apps/desktop-ui/src/chat/SubagentSessionPanel.test.tsx`

- [ ] **Step 1: Write route test for metadata fields**

In `apps/gateway/src/routes/subagentSessions.test.ts`, change the fixture session creation to include:

```ts
const session = sessions.create({
  parentConversationId: parent.id,
  parentRunId: parentRun.id,
  agentId: child.agentId,
  conversationId: child.id,
  label: "Read docs",
  title: "Read docs",
  task: "Find the relevant subagent behavior.",
});
```

Update the list assertion:

```ts
expect(await res.json()).toMatchObject({
  items: [
    {
      id: stores.session.id,
      title: "Read docs",
      task: "Find the relevant subagent behavior.",
      resultSummary: null,
      resultMessageId: null,
      completedAt: null,
      lastError: null,
    },
  ],
});
```

- [ ] **Step 2: Run the route test**

Run:

```bash
bun test apps/gateway/src/routes/subagentSessions.test.ts
```

Expected: PASS after Task 1. This confirms routes serialize the store object directly with the new fields.

- [ ] **Step 3: Extend desktop API DTO**

In `apps/desktop-ui/src/api/subagentSessions.ts`, update `SubagentSessionDto`:

```ts
export interface SubagentSessionDto {
  id: string;
  parentConversationId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  label: string;
  title: string | null;
  task: string | null;
  status: SubagentSessionStatus;
  messageCount: number;
  resultSummary: string | null;
  resultMessageId: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 4: Update desktop API test fixture**

In `apps/desktop-ui/src/api/subagentSessions.test.ts`, update `session`:

```ts
const session: SubagentSessionDto = {
  id: "sub-1",
  parentConversationId: "c-parent",
  parentRunId: "r-parent",
  agentId: "researcher",
  conversationId: "c-child",
  label: "Researcher",
  title: "Research docs",
  task: "Find context.",
  status: "active",
  messageCount: 2,
  resultSummary: null,
  resultMessageId: null,
  completedAt: null,
  lastError: null,
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:01:00.000Z",
};
```

- [ ] **Step 5: Write UI tests for task/result/failure display**

In `apps/desktop-ui/src/chat/SubagentSessionPanel.test.tsx`, update the fixture with the new DTO fields, then add:

```tsx
test("renders task title, objective, and completed result summary", () => {
  render(
    <SubagentSessionPanel
      sessions={[
        {
          ...session,
          status: "completed",
          title: "Research docs",
          task: "Find the relevant context.",
          resultSummary: "Context found in the Agents SDK docs.",
          resultMessageId: "m-2",
          completedAt: "2026-04-30T00:03:00.000Z",
        },
      ]}
      messagesBySessionId={{}}
      loadingSessionIds={new Set()}
      onLoadMessages={async () => {}}
    />,
  );

  expect(screen.getByText("子任务")).toBeDefined();
  expect(screen.getByText("Research docs")).toBeDefined();
  expect(screen.getByText("Find the relevant context.")).toBeDefined();
  expect(screen.getByText("Context found in the Agents SDK docs.")).toBeDefined();
  expect(screen.getByText("已完成")).toBeDefined();
});

test("renders failed subtask errors", () => {
  render(
    <SubagentSessionPanel
      sessions={[
        {
          ...session,
          status: "failed",
          title: "Research docs",
          task: "Find the relevant context.",
          lastError: "child exploded",
        },
      ]}
      messagesBySessionId={{}}
      loadingSessionIds={new Set()}
      onLoadMessages={async () => {}}
    />,
  );

  expect(screen.getByText("失败")).toBeDefined();
  expect(screen.getByText("child exploded")).toBeDefined();
});
```

- [ ] **Step 6: Update SubagentSessionPanel markup**

In `apps/desktop-ui/src/chat/SubagentSessionPanel.tsx`, change header copy and row content:

```tsx
<section className="subagent-panel" aria-label="子任务">
  <header className="subagent-panel-head">
    <div>
      <h3>子任务</h3>
      <p>{props.sessions.length} 个委派任务</p>
    </div>
  </header>
```

Inside the session map, compute:

```ts
const title = session.title || session.label || session.agentId;
const task = session.task?.trim() || null;
const result = session.resultSummary?.trim() || null;
const error = session.lastError?.trim() || null;
```

Replace the main labels:

```tsx
<span className="subagent-main">
  <strong>{title}</strong>
  <span>
    {subagent.name} · {formatMessageCount(session.messageCount)}
  </span>
</span>
```

Below the button, before expanded messages, render:

```tsx
{task ? <p className="subagent-task">{task}</p> : null}
{result ? (
  <p className="subagent-result">
    <span>结果</span>
    {result}
  </p>
) : null}
{error ? (
  <p className="subagent-error">
    <span>错误</span>
    {error}
  </p>
) : null}
```

- [ ] **Step 7: Add/adjust CSS if needed**

If `subagent-task`, `subagent-result`, and `subagent-error` have no styles in `apps/desktop-ui/src/styles.css`, add concise styles near existing `.subagent-*` rules:

```css
.subagent-task,
.subagent-result,
.subagent-error {
  margin: 0 12px 10px 46px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}

.subagent-result span,
.subagent-error span {
  margin-right: 6px;
  font-weight: 700;
  color: var(--text);
}

.subagent-error {
  color: var(--danger);
}
```

Before editing `apps/desktop-ui/src/styles.css`, check `git diff -- apps/desktop-ui/src/styles.css`. If it contains unrelated user changes, preserve them and append only these focused rules.

- [ ] **Step 8: Run API and UI tests**

Run:

```bash
bun test apps/gateway/src/routes/subagentSessions.test.ts apps/desktop-ui/src/api/subagentSessions.test.ts apps/desktop-ui/src/chat/SubagentSessionPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src/routes/subagentSessions.test.ts apps/desktop-ui/src/api/subagentSessions.ts apps/desktop-ui/src/api/subagentSessions.test.ts apps/desktop-ui/src/chat/SubagentSessionPanel.tsx apps/desktop-ui/src/chat/SubagentSessionPanel.test.tsx apps/desktop-ui/src/styles.css
git commit -m "Show subagent task results in chat"
```

If `apps/desktop-ui/src/styles.css` contained unrelated pre-existing changes, stage it carefully with `git add -p`.

## Task 4: Add Harness Coverage For Result Recovery

**Files:**
- Modify: `apps/gateway/src/harness/runtimeHarness.ts`
- Modify: `apps/gateway/src/harness/runtimeHarness.test.ts`
- Modify: `apps/gateway/src/harness/acceptanceSuite.ts`
- Modify: `apps/gateway/src/harness/acceptanceRunner.ts`
- Modify: `apps/gateway/src/harness/acceptanceRunner.test.ts`

- [ ] **Step 1: Add runtime harness scenario**

In `apps/gateway/src/harness/runtimeHarness.ts`, add a scenario after `subagent-suggestion-confirmation`:

```ts
{
  id: "subagent-result-recovery",
  name: "Subagent result recovery",
  description: "Parent agent spawns a subagent, yields completed child output, and integrates it into the final answer.",
  tags: ["runtime", "subagents", "product"],
  expectedStatus: "succeeded",
  expectedFinalText: "Integrated child result: harness coverage is ready",
  llm: () => async function* () {
    yield {
      kind: "tool.plan",
      callId: "c-subagent-spawn",
      tool: "sessions_spawn",
      input: {
        agentId: "researcher",
        title: "Check harness coverage",
        message: "Inspect harness coverage and return one sentence.",
      },
    };
    yield { kind: "await.tool", callId: "c-subagent-spawn" };
    yield {
      kind: "tool.plan",
      callId: "c-subagent-yield",
      tool: "sessions_yield",
      input: { limit: 20 },
    };
    const result = yield { kind: "await.tool", callId: "c-subagent-yield" };
    const completed = (result as { completed?: Array<{ resultSummary?: string }> }).completed ?? [];
    yield { kind: "final", text: `Integrated child result: ${completed[0]?.resultSummary ?? "missing"}` };
  },
  tool: async (call) => {
    if (call.tool === "sessions_spawn") return { sessionId: "subagent-1" };
    if (call.tool === "sessions_yield") {
      return {
        active: [],
        completed: [{ sessionId: "subagent-1", resultSummary: "harness coverage is ready" }],
        failed: [],
      };
    }
    throw new Error(`unexpected tool ${call.tool}`);
  },
}
```

- [ ] **Step 2: Add runtime harness test**

In `apps/gateway/src/harness/runtimeHarness.test.ts`, add:

```ts
test("runs the subagent result recovery scenario", async () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "vulture-runtime-harness-"));
  try {
    const results = await runRuntimeHarness({
      artifactDir,
      scenarios: ["subagent-result-recovery"],
      workspacePath: artifactDir,
    });
    expect(results).toMatchObject([
      {
        scenarioId: "subagent-result-recovery",
        status: "passed",
        finalText: "Integrated child result: harness coverage is ready",
      },
    ]);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run runtime harness tests**

Run:

```bash
bun test apps/gateway/src/harness/runtimeHarness.test.ts
```

Expected: PASS.

- [ ] **Step 4: Extend acceptance seeded workflow assertions**

In `apps/gateway/src/harness/acceptanceSuite.ts`, update the `agent-configured-subagent-product-workflow` scenario to assert result metadata after `listSubagentSessions`:

```ts
{
  action: "assertSubagentSessions",
  sessions: "subagents",
  containsSession: "subagent",
  parentConversation: "conversation",
  parentRun: "run",
  statuses: ["completed"],
  resultContains: "Runtime, tool contract",
}
```

If `statuses` currently expects `["active"]`, change it to `["completed"]` because the seeded child result is terminal.

- [ ] **Step 5: Add acceptance runner support for resultContains**

In `apps/gateway/src/harness/acceptanceRunner.ts`, extend the `assertSubagentSessions` step type with:

```ts
resultContains?: string;
```

Inside the assert handler, after status checks:

```ts
if (step.resultContains) {
  const target = step.containsSession
    ? requireAlias(state.resources.subagentSessions, step.containsSession, "subagent session")
    : sessions[0];
  if (!target?.resultSummary?.includes(step.resultContains)) {
    throw new Error(
      `Expected subagent result summary to contain ${JSON.stringify(step.resultContains)}, received ${JSON.stringify(target?.resultSummary ?? null)}`,
    );
  }
}
```

- [ ] **Step 6: Ensure seeded helper creates completed metadata**

In `seedApprovedSubagentWorkflow` or the helper it calls in `apps/gateway/src/harness/acceptanceRunner.ts`, after the child assistant message and child run success are created, call:

```ts
const refreshed = subagentSessions.refreshStatus(session.id);
state.resources.subagentSessions[input.asSubagent] = refreshed ?? session;
```

This ensures acceptance state and route reads both include terminal metadata.

- [ ] **Step 7: Run acceptance tests**

Run:

```bash
bun test apps/gateway/src/harness/acceptanceRunner.test.ts apps/gateway/src/harness/acceptanceSuite.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/harness/runtimeHarness.ts apps/gateway/src/harness/runtimeHarness.test.ts apps/gateway/src/harness/acceptanceSuite.ts apps/gateway/src/harness/acceptanceRunner.ts apps/gateway/src/harness/acceptanceRunner.test.ts
git commit -m "Cover subagent result recovery in harness"
```

## Task 5: Full Verification

**Files:**
- No source files expected beyond Tasks 1-4.

- [ ] **Step 1: Run focused test bundle**

Run:

```bash
bun test apps/gateway/src/domain/subagentSessionStore.test.ts apps/gateway/src/server/localTools.test.ts apps/gateway/src/routes/subagentSessions.test.ts apps/desktop-ui/src/api/subagentSessions.test.ts apps/desktop-ui/src/chat/SubagentSessionPanel.test.tsx packages/agent-runtime/src/promptAssembler.test.ts apps/gateway/src/harness/runtimeHarness.test.ts apps/gateway/src/harness/acceptanceRunner.test.ts apps/gateway/src/harness/acceptanceSuite.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typechecks**

Run:

```bash
bun --filter @vulture/gateway typecheck
bun --filter @vulture/desktop-ui typecheck
bun --filter @vulture/agent-runtime typecheck
```

Expected: all exit with code 0.

- [ ] **Step 3: Run full harness**

Run:

```bash
bun run harness:ci
```

Expected: `Harness CI: passed` and `Final artifact validation: passed`.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intentional changes from this plan are committed or staged. Preserve unrelated pre-existing changes such as `.claude/scheduled_tasks.lock`, `AppIcons/`, or user-owned UI edits.

- [ ] **Step 5: Final commit if verification-only fixes were needed**

If Task 5 required any code/test fixes, commit them:

```bash
git add apps/gateway/src apps/desktop-ui/src packages/agent-runtime/src packages/protocol/src docs/harness/acceptance.md
git commit -m "Stabilize subagent productization"
```

If no fixes were needed, do not create an empty commit.
