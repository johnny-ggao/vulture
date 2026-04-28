# Run Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and recover all in-flight runs after gateway restart without automatically replaying incomplete shell/browser tools.

**Architecture:** Persist Vulture recovery metadata plus OpenAI Agents SDK `RunState.toString()` in SQLite. On startup, classify queued/running runs into failed, recoverable, or auto-resume. Resume uses `RunState.fromStringWithContext(...)` and `Runner.run(agent, state, { stream: true })`; Vulture remains the adapter for local policy, audit, run events, and UI.

**Tech Stack:** Bun, TypeScript, Hono, SQLite, React, OpenAI Agents SDK `Runner` / `RunState`.

---

## Current Workspace Note

The current working tree already contains uncommitted OpenAI Agents SDK alignment changes in gateway runtime files. Do not revert them. This plan assumes the post-review runtime shape: per-run `OpenAIProvider`, API-safe SDK tool names, and SDK HITL approval bridge.

---

## File Map

- Modify: `packages/protocol/src/v1/run.ts`  
  Add `recoverable` status and recovery event schemas.
- Create: `apps/gateway/src/persistence/migrations/003_run_recovery.sql`  
  Add `run_recovery_state`.
- Modify: `apps/gateway/src/persistence/migrate.ts` and `apps/gateway/src/persistence/migrate.test.ts`  
  Register and verify migration 003.
- Modify: `apps/gateway/src/domain/runStore.ts` and `apps/gateway/src/domain/runStore.test.ts`  
  Add recovery state persistence, `markRecoverable`, active run listing, latest sequence, and terminal tool detection.
- Create: `apps/gateway/src/runtime/runRecovery.ts` and `apps/gateway/src/runtime/runRecovery.test.ts`  
  Classify startup runs and build resume actions.
- Modify: `packages/agent-runtime/src/runner.ts`  
  Add optional LLM recovery input/checkpoint hooks without changing existing callers.
- Modify: `apps/gateway/src/runtime/openaiLlm.ts` and `apps/gateway/src/runtime/openaiLlm.test.ts`  
  Checkpoint SDK state, restore SDK state, and support recovered retries.
- Modify: `apps/gateway/src/runtime/runOrchestrator.ts` and tests  
  Save initial recovery metadata, call recovered run path, clear recovery on terminal run.
- Modify: `apps/gateway/src/routes/runs.ts` and `apps/gateway/src/routes/runs.test.ts`  
  Add `POST /v1/runs/:rid/resume`; include recoverable in active filters and cancel path.
- Modify: `apps/gateway/src/server.ts`  
  Run startup recovery classifier and schedule auto-resume.
- Modify: `apps/desktop-ui/src/api/runs.ts`, `apps/desktop-ui/src/hooks/useRunStream.ts`, `apps/desktop-ui/src/chat/RunEventStream.tsx`, `apps/desktop-ui/src/chat/RunEventStream.test.tsx`  
  Add recoverable status, resume API, recovery stream status, and recovery card rendering.

---

## Task 1: Protocol Status And Events

**Files:**
- Modify: `packages/protocol/src/v1/run.ts`
- Test: `packages/protocol/src/v1/run.test.ts` if present; otherwise add coverage in existing protocol test location used by `bun test packages/protocol/src`

- [ ] **Step 1: Write the failing protocol test**

If no `run.test.ts` exists, create `packages/protocol/src/v1/run.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RunEventSchema, RunStatusSchema } from "./run";

describe("run protocol recovery additions", () => {
  test("accepts recoverable run status", () => {
    expect(RunStatusSchema.parse("recoverable")).toBe("recoverable");
  });

  test("accepts run recovery events", () => {
    expect(
      RunEventSchema.parse({
        type: "run.recoverable",
        runId: "r-1",
        seq: 0,
        createdAt: "2026-04-27T00:00:00.000Z",
        reason: "incomplete_tool",
        message: "Tool may need retry",
      }).type,
    ).toBe("run.recoverable");

    expect(
      RunEventSchema.parse({
        type: "run.recovered",
        runId: "r-1",
        seq: 1,
        createdAt: "2026-04-27T00:00:00.000Z",
        mode: "manual",
        discardPriorDraft: true,
      }).type,
    ).toBe("run.recovered");

    expect(
      RunEventSchema.parse({
        type: "tool.retrying",
        runId: "r-1",
        seq: 2,
        createdAt: "2026-04-27T00:00:00.000Z",
        callId: "c-1",
        tool: "shell.exec",
        input: { argv: ["pwd"] },
      }).type,
    ).toBe("tool.retrying");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test packages/protocol/src
```

Expected: fails because `recoverable`, `run.recoverable`, `run.recovered`, and `tool.retrying` are not in the schema.

- [ ] **Step 3: Implement protocol additions**

In `packages/protocol/src/v1/run.ts`, update status:

```ts
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "recoverable",
  "succeeded",
  "failed",
  "cancelled",
]);
```

Add these variants to `RunEventSchema` before terminal events:

```ts
  baseEvent.extend({
    type: z.literal("run.recoverable"),
    reason: z.enum(["gateway_restarted", "incomplete_tool", "approval_pending"]),
    message: z.string().min(1),
  }),
  baseEvent.extend({
    type: z.literal("run.recovered"),
    mode: z.enum(["auto", "manual"]),
    discardPriorDraft: z.boolean(),
  }),
  baseEvent.extend({
    type: z.literal("tool.retrying"),
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: z.unknown(),
  }),
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun test packages/protocol/src
```

Expected: protocol tests pass.

---

## Task 2: Migration 003

**Files:**
- Create: `apps/gateway/src/persistence/migrations/003_run_recovery.sql`
- Modify: `apps/gateway/src/persistence/migrate.ts`
- Modify: `apps/gateway/src/persistence/migrate.test.ts`

- [ ] **Step 1: Write failing migration test**

In `apps/gateway/src/persistence/migrate.test.ts`, add:

```ts
  test("003 adds run_recovery_state table", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v3-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(3);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("run_recovery_state");
    const columns = db
      .query("PRAGMA table_info(run_recovery_state)")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual([
      "run_id",
      "schema_version",
      "sdk_state",
      "metadata_json",
      "checkpoint_seq",
      "active_tool_json",
      "updated_at",
    ]);
    db.close();
    rmSync(dir, { recursive: true });
  });
```

Also update existing `currentSchemaVersion` expectations from `2` to `3`.

- [ ] **Step 2: Run migration tests and verify RED**

Run:

```bash
bun test apps/gateway/src/persistence/migrate.test.ts
```

Expected: fails because schema version remains `2` and table is missing.

- [ ] **Step 3: Add migration file**

Create `apps/gateway/src/persistence/migrations/003_run_recovery.sql`:

```sql
CREATE TABLE IF NOT EXISTS run_recovery_state (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  sdk_state TEXT,
  metadata_json TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL,
  active_tool_json TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version(version) VALUES (3);
```

- [ ] **Step 4: Register migration**

In `apps/gateway/src/persistence/migrate.ts`, import and register:

```ts
const init003 = readFileSync(join(here, "migrations", "003_run_recovery.sql"), "utf8");

const MIGRATIONS: Migration[] = [
  { version: 1, sql: init001 },
  { version: 2, sql: init002 },
  { version: 3, sql: init003 },
];
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
bun test apps/gateway/src/persistence/migrate.test.ts
```

Expected: migration tests pass.

---

## Task 3: RunStore Recovery Persistence

**Files:**
- Modify: `apps/gateway/src/domain/runStore.ts`
- Modify: `apps/gateway/src/domain/runStore.test.ts`

- [ ] **Step 1: Write failing RunStore tests**

In `apps/gateway/src/domain/runStore.test.ts`, add:

```ts
  test("save + load recovery state", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);

    runs.saveRecoveryState(r.id, {
      schemaVersion: 1,
      sdkState: "sdk-state-1",
      metadata: {
        runId: r.id,
        conversationId: c.id,
        agentId: c.agentId,
        model: "gpt-5.4",
        systemPrompt: "system",
        userInput: "hi",
        workspacePath: "/tmp/work",
        providerKind: "api_key",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      checkpointSeq: 7,
      activeTool: null,
    });

    expect(runs.getRecoveryState(r.id)).toMatchObject({
      schemaVersion: 1,
      sdkState: "sdk-state-1",
      checkpointSeq: 7,
      activeTool: null,
    });
    cleanup();
  });

  test("markRecoverable changes status without ending the run", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.markRunning(r.id);
    runs.markRecoverable(r.id);
    const recovered = runs.get(r.id)!;
    expect(recovered.status).toBe("recoverable");
    expect(recovered.endedAt).toBe(null);
    cleanup();
  });

  test("active filter includes recoverable runs", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.markRecoverable(r.id);
    expect(runs.listForConversation(c.id, { status: "active" }).map((x) => x.id)).toContain(r.id);
    cleanup();
  });

  test("detects terminal tool event for callId", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.appendEvent(r.id, { type: "tool.started", callId: "c1" });
    expect(runs.hasTerminalToolEvent(r.id, "c1")).toBe(false);
    runs.appendEvent(r.id, { type: "tool.completed", callId: "c1", output: "ok" });
    expect(runs.hasTerminalToolEvent(r.id, "c1")).toBe(true);
    cleanup();
  });
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/gateway/src/domain/runStore.test.ts
```

Expected: fails because recovery methods and `recoverable` status handling are missing.

- [ ] **Step 3: Add recovery types**

In `apps/gateway/src/domain/runStore.ts`, add:

```ts
export interface RunRecoveryMetadata {
  runId: string;
  conversationId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  userInput: string;
  workspacePath: string;
  providerKind: "codex" | "api_key" | "stub";
  updatedAt: string;
}

export interface ActiveToolRecovery {
  callId: string;
  tool: string;
  input: unknown;
  approvalToken?: string;
  startedSeq: number;
}

export interface RunRecoveryState {
  schemaVersion: number;
  sdkState: string | null;
  metadata: RunRecoveryMetadata;
  checkpointSeq: number;
  activeTool: ActiveToolRecovery | null;
}
```

- [ ] **Step 4: Implement persistence methods**

Add methods to `RunStore`:

```ts
  saveRecoveryState(runId: string, state: RunRecoveryState): void {
    this.db
      .query(
        `INSERT INTO run_recovery_state(
           run_id, schema_version, sdk_state, metadata_json, checkpoint_seq, active_tool_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           sdk_state = excluded.sdk_state,
           metadata_json = excluded.metadata_json,
           checkpoint_seq = excluded.checkpoint_seq,
           active_tool_json = excluded.active_tool_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        runId,
        state.schemaVersion,
        state.sdkState,
        JSON.stringify(state.metadata),
        state.checkpointSeq,
        state.activeTool ? JSON.stringify(state.activeTool) : null,
        nowIso8601(),
      );
  }

  getRecoveryState(runId: string): RunRecoveryState | null {
    const row = this.db
      .query("SELECT * FROM run_recovery_state WHERE run_id = ?")
      .get(runId) as
      | {
          schema_version: number;
          sdk_state: string | null;
          metadata_json: string;
          checkpoint_seq: number;
          active_tool_json: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      schemaVersion: row.schema_version,
      sdkState: row.sdk_state,
      metadata: JSON.parse(row.metadata_json) as RunRecoveryMetadata,
      checkpointSeq: row.checkpoint_seq,
      activeTool: row.active_tool_json
        ? (JSON.parse(row.active_tool_json) as ActiveToolRecovery)
        : null,
    };
  }

  clearRecoveryState(runId: string): void {
    this.db.query("DELETE FROM run_recovery_state WHERE run_id = ?").run(runId);
  }
```

- [ ] **Step 5: Implement status and helpers**

Update active filter SQL to include `recoverable`:

```ts
"SELECT * FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running', 'recoverable') ORDER BY started_at DESC, rowid DESC"
```

Add:

```ts
  markRecoverable(id: string): void {
    this.db.query("UPDATE runs SET status = 'recoverable' WHERE id = ?").run(id);
  }

  listInflight(): Run[] {
    const rows = this.db
      .query("SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY started_at ASC, rowid ASC")
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  latestSeq(runId: string): number {
    const row = this.db
      .query("SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?")
      .get(runId) as { s: number | null };
    return row.s ?? -1;
  }

  hasTerminalToolEvent(runId: string, callId: string): boolean {
    const row = this.db
      .query(
        "SELECT 1 FROM run_events WHERE run_id = ? AND type IN ('tool.completed', 'tool.failed') AND json_extract(payload_json, '$.callId') = ? LIMIT 1",
      )
      .get(runId, callId);
    return Boolean(row);
  }
```

- [ ] **Step 6: Verify GREEN**

Run:

```bash
bun test apps/gateway/src/domain/runStore.test.ts
```

Expected: RunStore tests pass.

---

## Task 4: Recovery Classifier

**Files:**
- Create: `apps/gateway/src/runtime/runRecovery.ts`
- Create: `apps/gateway/src/runtime/runRecovery.test.ts`

- [ ] **Step 1: Write classifier tests**

Create `apps/gateway/src/runtime/runRecovery.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { classifyInflightRun, type RecoveryCandidate } from "./runRecovery";

const base = (overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate => ({
  runId: "r-1",
  hasRecoveryState: true,
  sdkState: "sdk",
  activeTool: null,
  activeToolHasTerminalEvent: false,
  hasApprovalInterruption: false,
  ...overrides,
});

describe("classifyInflightRun", () => {
  test("missing recovery state fails", () => {
    expect(classifyInflightRun(base({ hasRecoveryState: false }))).toEqual({
      kind: "fail",
      error: {
        code: "internal.recovery_state_unavailable",
        message: "recovery state unavailable for r-1",
      },
    });
  });

  test("incomplete active tool becomes recoverable", () => {
    expect(
      classifyInflightRun(
        base({
          activeTool: {
            callId: "c1",
            tool: "shell.exec",
            input: {},
            startedSeq: 3,
          },
        }),
      ),
    ).toEqual({
      kind: "recoverable",
      reason: "incomplete_tool",
      message: "Tool shell.exec may have been interrupted before completion.",
    });
  });

  test("approval interruption becomes recoverable", () => {
    expect(classifyInflightRun(base({ hasApprovalInterruption: true }))).toEqual({
      kind: "recoverable",
      reason: "approval_pending",
      message: "Run is waiting for approval.",
    });
  });

  test("model-only checkpoint auto resumes", () => {
    expect(classifyInflightRun(base())).toEqual({ kind: "auto_resume" });
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/gateway/src/runtime/runRecovery.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement classifier**

Create `apps/gateway/src/runtime/runRecovery.ts`:

```ts
import type { ActiveToolRecovery } from "../domain/runStore";
import type { AppError } from "@vulture/protocol/src/v1/error";

export interface RecoveryCandidate {
  runId: string;
  hasRecoveryState: boolean;
  sdkState: string | null;
  activeTool: ActiveToolRecovery | null;
  activeToolHasTerminalEvent: boolean;
  hasApprovalInterruption: boolean;
}

export type RecoveryDecision =
  | { kind: "fail"; error: AppError }
  | { kind: "recoverable"; reason: "incomplete_tool" | "approval_pending"; message: string }
  | { kind: "auto_resume" };

export function classifyInflightRun(candidate: RecoveryCandidate): RecoveryDecision {
  if (!candidate.hasRecoveryState || !candidate.sdkState) {
    return {
      kind: "fail",
      error: {
        code: "internal.recovery_state_unavailable",
        message: `recovery state unavailable for ${candidate.runId}`,
      },
    };
  }
  if (candidate.activeTool && !candidate.activeToolHasTerminalEvent) {
    return {
      kind: "recoverable",
      reason: "incomplete_tool",
      message: `Tool ${candidate.activeTool.tool} may have been interrupted before completion.`,
    };
  }
  if (candidate.hasApprovalInterruption) {
    return {
      kind: "recoverable",
      reason: "approval_pending",
      message: "Run is waiting for approval.",
    };
  }
  return { kind: "auto_resume" };
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun test apps/gateway/src/runtime/runRecovery.test.ts
```

Expected: classifier tests pass.

---

## Task 5: LLM Recovery Contract

**Files:**
- Modify: `packages/agent-runtime/src/runner.ts`
- Modify: `packages/agent-runtime/src/runner.test.ts`

- [ ] **Step 1: Write failing type/behavior test**

In `packages/agent-runtime/src/runner.test.ts`, add a test that proves the runner forwards recovery hooks to the LLM:

```ts
  test("passes recovery options through to llm", async () => {
    let seen: unknown;
    const llm: LlmCallable = async function* (input) {
      seen = input.recovery;
      input.onCheckpoint?.({
        sdkState: "checkpoint",
        activeTool: null,
      });
      yield { kind: "final", text: "ok" };
    };
    await runConversation({
      runId: "r",
      agentId: "a",
      model: "gpt-5.4",
      systemPrompt: "s",
      userInput: "u",
      workspacePath: "/tmp/work",
      llm,
      tools: async () => ({}),
      recovery: { sdkState: "resume-state", retryToolCallId: null },
      onCheckpoint: () => {},
      onEvent: () => {},
    });
    expect(seen).toEqual({ sdkState: "resume-state", retryToolCallId: null });
  });
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test packages/agent-runtime/src/runner.test.ts
```

Expected: TypeScript/runtime failure because `RunConversationArgs` and `LlmCallable` do not expose recovery fields.

- [ ] **Step 3: Extend runtime types**

In `packages/agent-runtime/src/runner.ts`, add:

```ts
export interface LlmRecoveryInput {
  sdkState: string | null;
  retryToolCallId: string | null;
}

export interface LlmCheckpoint {
  sdkState: string | null;
  activeTool: {
    callId: string;
    tool: string;
    input: unknown;
    approvalToken?: string;
  } | null;
}
```

Extend `LlmCallable` input:

```ts
  recovery?: LlmRecoveryInput;
  onCheckpoint?: (checkpoint: LlmCheckpoint) => void;
```

Extend `RunConversationArgs`:

```ts
  recovery?: LlmRecoveryInput;
  onCheckpoint?: (checkpoint: LlmCheckpoint) => void;
```

Pass these through when calling `args.llm(...)`:

```ts
    gen = args.llm({
      systemPrompt: args.systemPrompt,
      userInput: args.userInput,
      model: args.model,
      runId: args.runId,
      workspacePath: args.workspacePath,
      recovery: args.recovery,
      onCheckpoint: args.onCheckpoint,
    });
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun test packages/agent-runtime/src/runner.test.ts
```

Expected: agent-runtime tests pass.

---

## Task 6: OpenAI LLM Checkpoint And Resume

**Files:**
- Modify: `apps/gateway/src/runtime/openaiLlm.ts`
- Modify: `apps/gateway/src/runtime/openaiLlm.test.ts`

- [ ] **Step 1: Write failing tests**

In `apps/gateway/src/runtime/openaiLlm.test.ts`, add tests through the injected `runFactory`:

```ts
  test("passes recovery input and checkpoint callback to runFactory", async () => {
    const checkpoints: unknown[] = [];
    const seen: unknown[] = [];
    const llm = makeOpenAILlm({
      apiKey: "sk-test",
      toolNames: [],
      toolCallable: async () => "noop",
      runFactory: (input) => {
        seen.push(input.recovery);
        input.onCheckpoint?.({ sdkState: "sdk-2", activeTool: null });
        return makeMockRun([{ kind: "final", text: "ok" }]);
      },
    });

    for await (const _ of llm({
      systemPrompt: "s",
      userInput: "u",
      model: "gpt-5.4",
      runId: "r",
      workspacePath: "/tmp/work",
      recovery: { sdkState: "sdk-1", retryToolCallId: null },
      onCheckpoint: (c) => checkpoints.push(c),
    })) {}

    expect(seen).toEqual([{ sdkState: "sdk-1", retryToolCallId: null }]);
    expect(checkpoints).toEqual([{ sdkState: "sdk-2", activeTool: null }]);
  });
```

Add a focused test for active tool checkpoint:

```ts
  test("emits active tool checkpoint when SDK tool starts", async () => {
    const tool = makeSdkTool("shell.exec") as unknown as TestFunctionTool;
    const checkpoints: unknown[] = [];
    await tool.invoke(
      {
        context: {
          runId: "r",
          workspacePath: "/tmp/work",
          sdkApprovedToolCalls: new Map(),
          onCheckpoint: (c: unknown) => checkpoints.push(c),
          toolCallable: async () => "ok",
        },
      } as never,
      JSON.stringify({ cwd: "/tmp/work", argv: ["pwd"], timeoutMs: null }),
      { toolCall: { callId: "c1" } },
    );
    expect(checkpoints[0]).toMatchObject({
      activeTool: {
        callId: "c1",
        tool: "shell.exec",
        input: { cwd: "/tmp/work", argv: ["pwd"], timeoutMs: null },
      },
    });
    expect(checkpoints.at(-1)).toMatchObject({ activeTool: null });
  });
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/gateway/src/runtime/openaiLlm.test.ts
```

Expected: compile/test failures because recovery fields are not wired.

- [ ] **Step 3: Extend `RunFactoryInput`**

In `apps/gateway/src/runtime/openaiLlm.ts`, import `LlmCheckpoint` / `LlmRecoveryInput` from `@vulture/agent-runtime` and add:

```ts
  recovery?: LlmRecoveryInput;
  onCheckpoint?: (checkpoint: LlmCheckpoint) => void;
```

Forward these from `makeOpenAILlm` to the factory.

- [ ] **Step 4: Restore SDK state in default factory**

In `defaultRunFactory`, if `input.recovery?.sdkState` is present:

```ts
import { RunContext, RunState } from "@openai/agents";

const runContext = new RunContext(context);
const runInput = input.recovery?.sdkState
  ? await RunState.fromStringWithContext(agent, input.recovery.sdkState, runContext)
  : input.userInput;

const stream = await runner.run(agent, runInput, {
  stream: true,
  context: runContext,
});
```

Keep using the existing per-run `Runner({ modelProvider })`.

- [ ] **Step 5: Emit SDK checkpoint after each stream completes or interrupts**

After `await stream.completed` and before final/interrupt handling:

```ts
input.onCheckpoint?.({
  sdkState: stream.state.toString(),
  activeTool: null,
});
```

If deserialization fails, throw an `Error` whose message includes `internal.recovery_state_invalid`; the orchestrator will translate that into an AppError.

- [ ] **Step 6: Track active tool checkpoints**

Extend `SdkRunContext`:

```ts
  onCheckpoint?: (checkpoint: LlmCheckpoint) => void;
```

Before invoking `ctx.toolCallable`, call:

```ts
ctx.onCheckpoint?.({
  sdkState: null,
  activeTool: {
    callId,
    tool: "shell.exec",
    input,
    approvalToken: ctx.sdkApprovedToolCalls?.get(callId),
  },
});
```

After successful or failed invocation, call:

```ts
ctx.onCheckpoint?.({ sdkState: null, activeTool: null });
```

Apply the same pattern for browser tools.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
bun test apps/gateway/src/runtime/openaiLlm.test.ts
```

Expected: openaiLlm tests pass.

---

## Task 7: Orchestrator Recovery Persistence

**Files:**
- Modify: `apps/gateway/src/runtime/runOrchestrator.ts`
- Modify: `apps/gateway/src/runtime/runOrchestrator.test.ts`

- [ ] **Step 1: Write failing orchestrator tests**

Add a test that normal runs save and clear recovery state:

```ts
test("orchestrateRun saves recovery metadata and clears it on success", async () => {
  const saved: unknown[] = [];
  const runs = makeRunStoreDouble({
    saveRecoveryState: (_runId, state) => saved.push(state),
    clearRecoveryState: mock(() => {}),
  });
  await orchestrateRun(
    {
      runs,
      messages: makeMessageStoreDouble(),
      conversations: makeConversationStoreDouble(),
      llm: async function* (input) {
        input.onCheckpoint?.({ sdkState: "sdk-1", activeTool: null });
        yield { kind: "final", text: "ok" };
      },
      tools: async () => "noop",
      cancelSignals: new Map(),
    },
    {
      runId: "r1",
      agentId: "a1",
      model: "gpt-5.4",
      systemPrompt: "sys",
      conversationId: "conv1",
      userInput: "hello",
      workspacePath: "/tmp/work",
    },
  );
  expect(saved.length).toBeGreaterThan(0);
  expect(saved[0]).toMatchObject({
    metadata: {
      runId: "r1",
      model: "gpt-5.4",
      userInput: "hello",
      workspacePath: "/tmp/work",
    },
  });
  expect(runs.clearRecoveryState).toHaveBeenCalledWith("r1");
});
```

Use the existing test style in `runOrchestrator.test.ts`; if there are no store doubles, create small objects implementing only methods used by `orchestrateRun`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/gateway/src/runtime/runOrchestrator.test.ts
```

Expected: fails because recovery metadata is not saved or cleared.

- [ ] **Step 3: Save initial recovery metadata**

In `orchestrateRun`, before `markRunning`:

```ts
const recoveryMetadata = {
  runId: args.runId,
  conversationId: args.conversationId,
  agentId: args.agentId,
  model: args.model,
  systemPrompt: args.systemPrompt,
  userInput: args.userInput,
  workspacePath: args.workspacePath,
  providerKind: "api_key" as const,
  updatedAt: new Date().toISOString(),
};
deps.runs.saveRecoveryState(args.runId, {
  schemaVersion: 1,
  sdkState: null,
  metadata: recoveryMetadata,
  checkpointSeq: deps.runs.latestSeq(args.runId),
  activeTool: null,
});
```

Provider kind can start as `"api_key"` for this task; a later task updates resolver/provider reporting.

- [ ] **Step 4: Wire checkpoint callback**

When calling `runConversation`, pass:

```ts
      recovery: args.recovery,
      onCheckpoint: (checkpoint) => {
        const previous = deps.runs.getRecoveryState(args.runId);
        deps.runs.saveRecoveryState(args.runId, {
          schemaVersion: 1,
          sdkState: checkpoint.sdkState ?? previous?.sdkState ?? null,
          metadata: previous?.metadata ?? recoveryMetadata,
          checkpointSeq: deps.runs.latestSeq(args.runId),
          activeTool: checkpoint.activeTool
            ? { ...checkpoint.activeTool, startedSeq: deps.runs.latestSeq(args.runId) }
            : null,
        });
      },
```

Add `recovery?: LlmRecoveryInput` to `OrchestrateArgs`.

- [ ] **Step 5: Clear recovery on terminal status**

After success, failure, or cancellation paths:

```ts
deps.runs.clearRecoveryState(args.runId);
```

Do not clear when marking `recoverable`.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
bun test apps/gateway/src/runtime/runOrchestrator.test.ts
```

Expected: orchestrator tests pass.

---

## Task 8: Startup Recovery And Resume Route

**Files:**
- Modify: `apps/gateway/src/routes/runs.ts`
- Modify: `apps/gateway/src/routes/runs.test.ts`
- Modify: `apps/gateway/src/server.ts`
- Modify: `apps/gateway/src/server.integration.test.ts` or `apps/gateway/src/runs.integration.test.ts`

- [ ] **Step 1: Write route tests**

In `apps/gateway/src/routes/runs.test.ts`, add:

```ts
test("POST /v1/runs/:rid/resume schedules recoverable run", async () => {
  const deps = makeRunsDeps();
  const run = seedRecoverableRun(deps);
  const res = await app.request(`/v1/runs/${run.id}/resume`, {
    method: "POST",
    headers: authHeaders(),
  });
  expect(res.status).toBe(202);
  expect(deps.resumeRun).toHaveBeenCalledWith(run.id, "manual");
});

test("POST /v1/runs/:rid/resume rejects terminal run", async () => {
  const deps = makeRunsDeps();
  const run = seedSucceededRun(deps);
  const res = await app.request(`/v1/runs/${run.id}/resume`, {
    method: "POST",
    headers: authHeaders(),
  });
  expect(res.status).toBe(409);
});
```

Use the helper names that exist in the file; if they do not exist, add local helpers with the same pattern as other route tests.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test apps/gateway/src/routes/runs.test.ts
```

Expected: route missing.

- [ ] **Step 3: Extend route deps**

In `RunsDeps`, add:

```ts
  resumeRun(runId: string, mode: "auto" | "manual"): void;
```

Update `runsRouter` callers in tests and server.

- [ ] **Step 4: Add resume route**

In `runsRouter`:

```ts
  app.post("/v1/runs/:rid/resume", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    if (run.status !== "recoverable") {
      return c.json({ code: "run.not_recoverable", message: run.status }, 409);
    }
    deps.resumeRun(rid, "manual");
    return c.json(deps.runs.get(rid), 202);
  });
```

Update `RUN_STATUS_FILTERS` to include `recoverable`.

- [ ] **Step 5: Update cancel route**

The existing terminal guard should remain:

```ts
if (["succeeded", "failed", "cancelled"].includes(run.status)) { ... }
```

This already allows `recoverable`; add a route test proving cancel marks a recoverable run cancelled.

- [ ] **Step 6: Implement server startup classification**

In `apps/gateway/src/server.ts`, replace startup sweep:

```ts
const recoveryActions = recoverInflightRuns({
  runs: runStore,
});
for (const action of recoveryActions) {
  if (action.kind === "auto_resume") {
    resumeRun(action.runId, "auto");
  }
}
```

Implement `resumeRun` in `buildServer`:

```ts
const resumeRun = (runId: string, mode: "auto" | "manual") => {
  const state = runStore.getRecoveryState(runId);
  const run = runStore.get(runId);
  if (!state || !run) return;
  runStore.markRunning(runId);
  runStore.appendEvent(runId, {
    type: "run.recovered",
    mode,
    discardPriorDraft: true,
  });
  orchestrateRun(
    { runs: runStore, messages: messageStore, conversations: conversationStore, llm, tools, cancelSignals },
    {
      runId,
      agentId: state.metadata.agentId,
      model: state.metadata.model,
      systemPrompt: state.metadata.systemPrompt,
      workspacePath: state.metadata.workspacePath,
      conversationId: state.metadata.conversationId,
      userInput: state.metadata.userInput,
      recovery: {
        sdkState: state.sdkState,
        retryToolCallId: state.activeTool?.callId ?? null,
      },
    },
  ).catch((err) => {
    runStore.markRecoverable(runId);
    runStore.appendEvent(runId, {
      type: "run.recoverable",
      reason: "gateway_restarted",
      message: err instanceof Error ? err.message : String(err),
    });
  });
};
```

- [ ] **Step 7: Implement `recoverInflightRuns` helper**

In `apps/gateway/src/runtime/runRecovery.ts`, add:

```ts
export function recoverInflightRuns(deps: { runs: RunStore }): Array<{ kind: "auto_resume"; runId: string }> {
  const actions: Array<{ kind: "auto_resume"; runId: string }> = [];
  for (const run of deps.runs.listInflight()) {
    const state = deps.runs.getRecoveryState(run.id);
    const decision = classifyInflightRun({
      runId: run.id,
      hasRecoveryState: Boolean(state),
      sdkState: state?.sdkState ?? null,
      activeTool: state?.activeTool ?? null,
      activeToolHasTerminalEvent: state?.activeTool
        ? deps.runs.hasTerminalToolEvent(run.id, state.activeTool.callId)
        : false,
      hasApprovalInterruption: false,
    });
    if (decision.kind === "fail") deps.runs.markFailed(run.id, decision.error);
    if (decision.kind === "recoverable") {
      deps.runs.markRecoverable(run.id);
      deps.runs.appendEvent(run.id, {
        type: "run.recoverable",
        reason: decision.reason,
        message: decision.message,
      });
    }
    if (decision.kind === "auto_resume") actions.push({ kind: "auto_resume", runId: run.id });
  }
  return actions;
}
```

Approval interruption detection can initially be `false`; Task 9 hardens it by asking SDK to deserialize state and inspect interruptions.

- [ ] **Step 8: Verify route and integration tests**

Run:

```bash
bun test apps/gateway/src/routes/runs.test.ts apps/gateway/src/runs.integration.test.ts apps/gateway/src/server.integration.test.ts
```

Expected: tests pass.

---

## Task 9: SDK Approval Interruption Detection

**Files:**
- Modify: `apps/gateway/src/runtime/runRecovery.ts`
- Modify: `apps/gateway/src/runtime/runRecovery.test.ts`
- Modify: `apps/gateway/src/runtime/openaiLlm.ts` if a helper is needed

- [ ] **Step 1: Write failing test for SDK interruption state**

Add to `runRecovery.test.ts`:

```ts
test("approval interruption flag makes run recoverable", () => {
  expect(
    classifyInflightRun({
      runId: "r-approval",
      hasRecoveryState: true,
      sdkState: "serialized-sdk-state",
      activeTool: null,
      activeToolHasTerminalEvent: false,
      hasApprovalInterruption: true,
    }),
  ).toMatchObject({
    kind: "recoverable",
    reason: "approval_pending",
  });
});
```

This is already covered by Task 4. Add a higher-level test around `recoverInflightRuns` with a dependency-injected `hasApprovalInterruption` function:

```ts
test("recoverInflightRuns marks SDK approval interruptions recoverable", () => {
  const runs = makeRunStoreDoubleWithInflightState();
  recoverInflightRuns({
    runs,
    hasApprovalInterruption: async () => true,
  });
  expect(runs.markRecoverable).toHaveBeenCalledWith("r-1");
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
bun test apps/gateway/src/runtime/runRecovery.test.ts
```

Expected: `recoverInflightRuns` does not accept the hook yet.

- [ ] **Step 3: Add async approval detection hook**

Change `recoverInflightRuns` to async:

```ts
export async function recoverInflightRuns(deps: {
  runs: RunStore;
  hasApprovalInterruption?: (sdkState: string) => Promise<boolean>;
}): Promise<Array<{ kind: "auto_resume"; runId: string }>> {
  ...
  const hasApprovalInterruption =
    state?.sdkState && deps.hasApprovalInterruption
      ? await deps.hasApprovalInterruption(state.sdkState)
      : false;
  ...
}
```

- [ ] **Step 4: Wire SDK deserialization detector**

In `openaiLlm.ts`, export:

```ts
export async function sdkStateHasInterruptions(opts: {
  sdkState: string;
  agent: Agent<SdkRunContext, any>;
  context: SdkRunContext;
}): Promise<boolean> {
  const runContext = new RunContext(opts.context);
  const state = await RunState.fromStringWithContext(opts.agent, opts.sdkState, runContext);
  return state.getInterruptions().length > 0;
}
```

If the agent cannot be rebuilt at startup before provider auth exists, catch the error in server and return `false`; invalid SDK state is handled when resume attempts to deserialize.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
bun test apps/gateway/src/runtime/runRecovery.test.ts apps/gateway/src/runtime/openaiLlm.test.ts
```

Expected: tests pass.

---

## Task 10: UI Recoverable Status And Recovery Card

**Files:**
- Modify: `apps/desktop-ui/src/api/runs.ts`
- Modify: `apps/desktop-ui/src/hooks/useRunStream.ts`
- Modify: `apps/desktop-ui/src/chat/RunEventStream.tsx`
- Modify: `apps/desktop-ui/src/chat/RunEventStream.test.tsx`
- Create: `apps/desktop-ui/src/chat/RecoveryCard.tsx`

- [ ] **Step 1: Write failing reducer/UI tests**

In `RunEventStream.test.tsx`, add:

```ts
  test("run.recoverable becomes a recovery block", () => {
    const blocks = reduceRunEvents([
      ev({
        type: "run.recoverable",
        seq: 1,
        reason: "incomplete_tool",
        message: "Tool may need retry",
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("recovery");
  });

  test("run.recovered starts a new text block after recovery boundary", () => {
    const blocks = reduceRunEvents([
      ev({ type: "text.delta", seq: 1, text: "before" }),
      ev({ type: "run.recovered", seq: 2, mode: "manual", discardPriorDraft: true }),
      ev({ type: "text.delta", seq: 3, text: "after" }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "recovery-boundary", "text"]);
  });
```

In `useRunStream` reducer tests if present, assert `run.recoverable` sets status to `recoverable`.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
bun test apps/desktop-ui/src/chat/RunEventStream.test.tsx
```

Expected: recovery block kinds missing.

- [ ] **Step 3: Extend API types**

In `apps/desktop-ui/src/api/runs.ts`:

```ts
export type RunStatus = "queued" | "running" | "recoverable" | "succeeded" | "failed" | "cancelled";

resume: (client: ApiClient, runId: string) =>
  client.post<RunDto>(`/v1/runs/${runId}/resume`, {}),
```

- [ ] **Step 4: Extend stream status**

In `useRunStream.ts`:

```ts
export type RunStreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "recoverable"
  | "succeeded"
  | "failed"
  | "cancelled";

const TERMINAL: RunStreamStatus[] = ["recoverable", "succeeded", "failed", "cancelled"];
```

In reducer:

```ts
else if (action.event.type === "run.recoverable") status = "recoverable";
```

In the SSE loop terminal check, include `run.recoverable`.

- [ ] **Step 5: Add RecoveryCard**

Create `apps/desktop-ui/src/chat/RecoveryCard.tsx`:

```tsx
export interface RecoveryCardProps {
  message: string;
  busy: boolean;
  onResume: () => void;
  onCancel: () => void;
}

export function RecoveryCard(props: RecoveryCardProps) {
  return (
    <div className="approval-card">
      <div className="approval-card-header">
        <strong>运行可恢复</strong>
      </div>
      <p className="approval-card-reason">{props.message}</p>
      <div className="approval-card-actions">
        <button type="button" className="approval-card-deny" disabled={props.busy} onClick={props.onCancel}>
          取消
        </button>
        <button type="button" className="approval-card-allow" disabled={props.busy} onClick={props.onResume}>
          {props.busy ? "..." : "继续"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Extend RunEventStream block reducer**

Add block types:

```ts
  | { kind: "recovery"; message: string; firstSeq: number }
  | { kind: "recovery-boundary"; firstSeq: number };
```

Handle events:

```ts
      case "run.recoverable":
        blocks.push({
          kind: "recovery",
          message: String(e.message ?? "运行可恢复"),
          firstSeq: e.seq,
        });
        break;
      case "run.recovered":
        if (Boolean(e.discardPriorDraft)) {
          blocks.push({ kind: "recovery-boundary", firstSeq: e.seq });
        }
        break;
```

Render `recovery-boundary` as a small divider. Render `RecoveryCard` with callbacks passed through props.

- [ ] **Step 7: Wire callbacks through ChatView/App**

Add props to `RunEventStreamProps`:

```ts
onResumeRun: () => void;
onCancelRun: () => void;
submittingRecovery: boolean;
```

In `App.tsx`, add handler:

```ts
async function handleResumeRun() {
  if (!client || !activeRunId) return;
  await runsApi.resume(client, activeRunId);
}
```

Pass `handleResumeRun` and existing `handleCancel` through `ChatView` to `RunEventStream`.

- [ ] **Step 8: Verify UI tests and typecheck**

Run:

```bash
bun test apps/desktop-ui/src/chat/RunEventStream.test.tsx
bun --filter @vulture/desktop-ui typecheck
```

Expected: UI tests and typecheck pass.

---

## Task 11: Full Gateway Verification

**Files:**
- No new files unless tests reveal small fixes.

- [ ] **Step 1: Run gateway tests**

Run:

```bash
bun test apps/gateway/src
```

Expected: all gateway tests pass. The smoke test may remain skipped if it requires real API credentials.

- [ ] **Step 2: Run workspace typecheck**

Run:

```bash
bun --filter '*' typecheck
```

Expected: all workspace packages typecheck.

- [ ] **Step 3: Run protocol tests**

Run:

```bash
bun test packages/protocol/src
```

Expected: protocol tests pass.

- [ ] **Step 4: Commit implementation**

Stage only files changed for run recovery. Do not stage unrelated `.claude/` or user edits.

```bash
git add \
  packages/protocol/src/v1/run.ts \
  packages/protocol/src/v1/run.test.ts \
  packages/agent-runtime/src/runner.ts \
  packages/agent-runtime/src/runner.test.ts \
  apps/gateway/src/persistence/migrations/003_run_recovery.sql \
  apps/gateway/src/persistence/migrate.ts \
  apps/gateway/src/persistence/migrate.test.ts \
  apps/gateway/src/domain/runStore.ts \
  apps/gateway/src/domain/runStore.test.ts \
  apps/gateway/src/runtime/runRecovery.ts \
  apps/gateway/src/runtime/runRecovery.test.ts \
  apps/gateway/src/runtime/openaiLlm.ts \
  apps/gateway/src/runtime/openaiLlm.test.ts \
  apps/gateway/src/runtime/runOrchestrator.ts \
  apps/gateway/src/runtime/runOrchestrator.test.ts \
  apps/gateway/src/routes/runs.ts \
  apps/gateway/src/routes/runs.test.ts \
  apps/gateway/src/server.ts \
  apps/desktop-ui/src/api/runs.ts \
  apps/desktop-ui/src/hooks/useRunStream.ts \
  apps/desktop-ui/src/chat/RecoveryCard.tsx \
  apps/desktop-ui/src/chat/RunEventStream.tsx \
  apps/desktop-ui/src/chat/RunEventStream.test.tsx \
  apps/desktop-ui/src/App.tsx
git commit -m "feat: recover in-flight runs"
```

Expected: commit succeeds.

---

## Self-Review

Spec coverage:

- Recoverable status and recovery events: Task 1.
- SQLite recovery state: Task 2 and Task 3.
- Conservative incomplete-tool recovery: Task 4, Task 8.
- OpenAI Agents SDK `RunState` serialization/resume: Task 6 and Task 9.
- Startup recovery and manual resume route: Task 8.
- UI recovery card and boundary: Task 10.
- Verification: Task 11.

Completion scan: no red-flag gaps remain.

Type consistency:

- `recoverable` is added in protocol, API types, stream reducer, and RunStore filters.
- `run.recoverable`, `run.recovered`, and `tool.retrying` are protocol events and UI reducer inputs.
- `LlmRecoveryInput` and `LlmCheckpoint` are defined once in `packages/agent-runtime/src/runner.ts` and consumed by gateway.
