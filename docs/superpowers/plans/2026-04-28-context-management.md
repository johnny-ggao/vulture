# Context Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Vulture-managed conversation context so same-conversation runs receive recent history and older turns are compressed into a bounded local summary.

**Architecture:** Gateway owns a local SQLite-backed Agents SDK `Session` per Vulture conversation. A deterministic `sessionInputCallback` injects the current conversation summary plus recent raw text turns. A best-effort compactor updates summaries after successful runs without blocking chat completion.

**Tech Stack:** Bun tests, TypeScript, Hono, SQLite migrations, `@openai/agents` `Session` / `SessionInputCallback`, existing Gateway run orchestration.

---

## File Structure

- Create `apps/gateway/src/persistence/migrations/011_conversation_context.sql`
  - Adds `conversation_contexts` and `conversation_session_items`.
- Modify `apps/gateway/src/persistence/migrate.ts`
  - Registers migration 11.
- Modify `apps/gateway/src/persistence/migrate.test.ts`
  - Verifies new tables and indexes.
- Create `apps/gateway/src/domain/conversationContextStore.ts`
  - Owns summary rows and SDK session item persistence.
- Create `apps/gateway/src/domain/conversationContextStore.test.ts`
  - Covers session CRUD, summary upsert, invalid JSON skip, and delete.
- Create `apps/gateway/src/runtime/conversationSession.ts`
  - Implements OpenAI Agents SDK `Session` for one conversation.
- Create `apps/gateway/src/runtime/conversationSession.test.ts`
  - Verifies SDK session methods delegate correctly to the store.
- Create `apps/gateway/src/runtime/conversationContext.ts`
  - Builds session input callback, recent-history trimming, synthetic summary item, and compaction thresholds.
- Create `apps/gateway/src/runtime/conversationContext.test.ts`
  - Covers summary + recent turns + new turn shaping and fallback behavior.
- Create `apps/gateway/src/runtime/conversationCompactor.ts`
  - Runs no-tools summarization and updates summary state.
- Create `apps/gateway/src/runtime/conversationCompactor.test.ts`
  - Covers prompt content, summary cap, unchanged-on-failure, and summarized-through marker.
- Modify `packages/agent-runtime/src/runner.ts`
  - Extends `LlmCallable` / `RunConversationArgs` with SDK session inputs passed through to the LLM adapter.
- Modify `apps/gateway/src/runtime/openaiLlm.ts`
  - Passes `session` and `sessionInputCallback` into `Runner.run`.
- Modify `apps/gateway/src/runtime/openaiLlm.test.ts`
  - Verifies run factory receives session fields and `defaultRunFactory` builds runner options.
- Modify `apps/gateway/src/runtime/runOrchestrator.ts`
  - Accepts optional session data and reports `resultMessageId` to success hooks.
- Modify `apps/gateway/src/runtime/runOrchestrator.test.ts`
  - Verifies session data reaches LLM and success hook receives result message id.
- Modify `apps/gateway/src/routes/runs.ts`
  - Appends user session item before run, constructs `VultureConversationSession`, and wires compaction hook.
- Modify `apps/gateway/src/routes/runs.test.ts`
  - Verifies continuity plumbing and graceful compaction fallback.
- Modify `apps/gateway/src/routes/conversations.ts`
  - Adds `GET /v1/conversations/:id/context` and deletes context rows on conversation delete.
- Modify `apps/gateway/src/routes/conversations.test.ts`
  - Verifies context route and delete cleanup.
- Modify `apps/gateway/src/server.ts`
  - Instantiates store, session factory, no-tools LLM, compactor, and routes.

---

### Task 1: SQLite Context Store

**Files:**
- Create: `apps/gateway/src/persistence/migrations/011_conversation_context.sql`
- Modify: `apps/gateway/src/persistence/migrate.ts`
- Modify: `apps/gateway/src/persistence/migrate.test.ts`
- Create: `apps/gateway/src/domain/conversationContextStore.ts`
- Create: `apps/gateway/src/domain/conversationContextStore.test.ts`

- [ ] **Step 1: Write failing migration tests**

Add to `apps/gateway/src/persistence/migrate.test.ts`:

```ts
test("migration 11 creates conversation context tables", () => {
  const { db, cleanup } = freshDb();
  try {
    const contextColumns = db
      .query("PRAGMA table_info(conversation_contexts)")
      .all() as Array<{ name: string }>;
    expect(contextColumns.map((column) => column.name)).toContain("conversation_id");
    expect(contextColumns.map((column) => column.name)).toContain("summary");
    expect(contextColumns.map((column) => column.name)).toContain("summarized_through_message_id");

    const itemColumns = db
      .query("PRAGMA table_info(conversation_session_items)")
      .all() as Array<{ name: string }>;
    expect(itemColumns.map((column) => column.name)).toContain("item_json");
    expect(itemColumns.map((column) => column.name)).toContain("message_id");

    expect(currentSchemaVersion(db)).toBe(11);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run migration test to verify it fails**

Run: `bun test apps/gateway/src/persistence/migrate.test.ts --test-name-pattern "migration 11"`

Expected: FAIL because `conversation_contexts` does not exist or schema version is `10`.

- [ ] **Step 3: Add migration 11**

Create `apps/gateway/src/persistence/migrations/011_conversation_context.sql`:

```sql
CREATE TABLE IF NOT EXISTS conversation_contexts (
  conversation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summarized_through_message_id TEXT,
  input_item_count INTEGER NOT NULL DEFAULT 0,
  input_char_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_session_items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  role TEXT NOT NULL,
  item_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_session_items_conversation
  ON conversation_session_items(conversation_id, created_at, rowid);

INSERT OR IGNORE INTO schema_version(version) VALUES (11);
```

Modify `apps/gateway/src/persistence/migrate.ts`:

```ts
const init011 = readFileSync(join(here, "migrations", "011_conversation_context.sql"), "utf8");
```

Add to `MIGRATIONS`:

```ts
{ version: 11, sql: init011 },
```

- [ ] **Step 4: Run migration test to verify it passes**

Run: `bun test apps/gateway/src/persistence/migrate.test.ts --test-name-pattern "migration 11"`

Expected: PASS.

- [ ] **Step 5: Write failing store tests**

Create `apps/gateway/src/domain/conversationContextStore.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationContextStore } from "./conversationContextStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-context-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const store = new ConversationContextStore(db);
  return { db, store, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("ConversationContextStore", () => {
  test("adds, lists, pops, and clears session items", () => {
    const { store, cleanup } = fresh();
    try {
      store.addSessionItems("c-1", [
        { messageId: "m-1", role: "user", item: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
        { messageId: "m-2", role: "assistant", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } },
      ]);

      expect(store.listSessionItems("c-1")).toHaveLength(2);
      expect(store.listSessionItems("c-1", 1).map((item) => item.messageId)).toEqual(["m-2"]);
      expect(store.popSessionItem("c-1")?.messageId).toBe("m-2");
      expect(store.listSessionItems("c-1").map((item) => item.messageId)).toEqual(["m-1"]);
      store.clearSession("c-1");
      expect(store.listSessionItems("c-1")).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("upserts and reads context summary", () => {
    const { store, cleanup } = fresh();
    try {
      store.upsertContext({
        conversationId: "c-1",
        agentId: "a-1",
        summary: "Project code is alpha-17.",
        summarizedThroughMessageId: "m-9",
        inputItemCount: 10,
        inputCharCount: 900,
      });

      expect(store.getContext("c-1")).toMatchObject({
        conversationId: "c-1",
        agentId: "a-1",
        summary: "Project code is alpha-17.",
        summarizedThroughMessageId: "m-9",
        inputItemCount: 10,
        inputCharCount: 900,
      });
    } finally {
      cleanup();
    }
  });

  test("skips invalid session JSON instead of throwing", () => {
    const { db, store, cleanup } = fresh();
    try {
      db.query(
        "INSERT INTO conversation_session_items(id, conversation_id, message_id, role, item_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("bad", "c-1", "m-bad", "user", "{bad", new Date().toISOString());

      expect(store.listSessionItems("c-1")).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("deleteConversation removes context and session items", () => {
    const { store, cleanup } = fresh();
    try {
      store.addSessionItems("c-1", [
        { messageId: "m-1", role: "user", item: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      ]);
      store.upsertContext({
        conversationId: "c-1",
        agentId: "a-1",
        summary: "summary",
        summarizedThroughMessageId: "m-1",
        inputItemCount: 1,
        inputCharCount: 5,
      });

      store.deleteConversation("c-1");

      expect(store.listSessionItems("c-1")).toEqual([]);
      expect(store.getContext("c-1")).toBeNull();
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 6: Run store tests to verify they fail**

Run: `bun test apps/gateway/src/domain/conversationContextStore.test.ts`

Expected: FAIL because `ConversationContextStore` does not exist.

- [ ] **Step 7: Implement store**

Create `apps/gateway/src/domain/conversationContextStore.ts`:

```ts
import type { AgentInputItem } from "@openai/agents";
import type { DB } from "../persistence/sqlite";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";

export interface StoredSessionItem {
  id: string;
  conversationId: string;
  messageId: string | null;
  role: string;
  item: AgentInputItem;
  createdAt: Iso8601;
}

export interface AddSessionItemInput {
  messageId: string | null;
  role: string;
  item: AgentInputItem;
}

export interface ConversationContext {
  conversationId: string;
  agentId: string;
  summary: string;
  summarizedThroughMessageId: string | null;
  inputItemCount: number;
  inputCharCount: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

interface SessionItemRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  role: string;
  item_json: string;
  created_at: string;
}

interface ContextRow {
  conversation_id: string;
  agent_id: string;
  summary: string;
  summarized_through_message_id: string | null;
  input_item_count: number;
  input_char_count: number;
  created_at: string;
  updated_at: string;
}

export class ConversationContextStore {
  constructor(private readonly db: DB) {}

  listSessionItems(conversationId: string, limit?: number): StoredSessionItem[] {
    const rows = typeof limit === "number" && limit > 0
      ? this.db.query(
          `SELECT * FROM (
             SELECT * FROM conversation_session_items
             WHERE conversation_id = ?
             ORDER BY rowid DESC
             LIMIT ?
           ) ORDER BY rowid ASC`,
        ).all(conversationId, limit)
      : this.db.query(
          "SELECT * FROM conversation_session_items WHERE conversation_id = ? ORDER BY rowid ASC",
        ).all(conversationId);
    return (rows as SessionItemRow[]).flatMap((row) => {
      const parsed = tryParseItem(row.item_json);
      if (!parsed) return [];
      return [{
        id: row.id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        role: row.role,
        item: parsed,
        createdAt: row.created_at as Iso8601,
      }];
    });
  }

  addSessionItems(conversationId: string, items: AddSessionItemInput[]): void {
    const insert = this.db.query(
      `INSERT INTO conversation_session_items(id, conversation_id, message_id, role, item_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const now = nowIso8601();
    for (const item of items) {
      insert.run(`csi-${crypto.randomUUID()}`, conversationId, item.messageId, item.role, JSON.stringify(item.item), now);
    }
  }

  popSessionItem(conversationId: string): StoredSessionItem | undefined {
    const row = this.db.query(
      "SELECT * FROM conversation_session_items WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(conversationId) as SessionItemRow | undefined;
    if (!row) return undefined;
    this.db.query("DELETE FROM conversation_session_items WHERE id = ?").run(row.id);
    const parsed = tryParseItem(row.item_json);
    if (!parsed) return undefined;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      role: row.role,
      item: parsed,
      createdAt: row.created_at as Iso8601,
    };
  }

  clearSession(conversationId: string): void {
    this.db.query("DELETE FROM conversation_session_items WHERE conversation_id = ?").run(conversationId);
  }

  getContext(conversationId: string): ConversationContext | null {
    const row = this.db.query("SELECT * FROM conversation_contexts WHERE conversation_id = ?").get(conversationId) as ContextRow | undefined;
    return row ? rowToContext(row) : null;
  }

  upsertContext(input: {
    conversationId: string;
    agentId: string;
    summary: string;
    summarizedThroughMessageId: string | null;
    inputItemCount: number;
    inputCharCount: number;
  }): ConversationContext {
    const now = nowIso8601();
    const existing = this.getContext(input.conversationId);
    if (existing) {
      this.db.query(
        `UPDATE conversation_contexts
         SET agent_id = ?, summary = ?, summarized_through_message_id = ?,
             input_item_count = ?, input_char_count = ?, updated_at = ?
         WHERE conversation_id = ?`,
      ).run(input.agentId, input.summary, input.summarizedThroughMessageId, input.inputItemCount, input.inputCharCount, now, input.conversationId);
    } else {
      this.db.query(
        `INSERT INTO conversation_contexts(
           conversation_id, agent_id, summary, summarized_through_message_id,
           input_item_count, input_char_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.conversationId, input.agentId, input.summary, input.summarizedThroughMessageId, input.inputItemCount, input.inputCharCount, now, now);
    }
    return this.getContext(input.conversationId) as ConversationContext;
  }

  deleteConversation(conversationId: string): void {
    this.clearSession(conversationId);
    this.db.query("DELETE FROM conversation_contexts WHERE conversation_id = ?").run(conversationId);
  }
}

function rowToContext(row: ContextRow): ConversationContext {
  return {
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    summary: row.summary,
    summarizedThroughMessageId: row.summarized_through_message_id,
    inputItemCount: row.input_item_count,
    inputCharCount: row.input_char_count,
    createdAt: row.created_at as Iso8601,
    updatedAt: row.updated_at as Iso8601,
  };
}

function tryParseItem(value: string): AgentInputItem | null {
  try {
    return JSON.parse(value) as AgentInputItem;
  } catch {
    return null;
  }
}
```

- [ ] **Step 8: Run store and migration tests**

Run:

```bash
bun test apps/gateway/src/persistence/migrate.test.ts apps/gateway/src/domain/conversationContextStore.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src/persistence/migrate.ts \
  apps/gateway/src/persistence/migrations/011_conversation_context.sql \
  apps/gateway/src/persistence/migrate.test.ts \
  apps/gateway/src/domain/conversationContextStore.ts \
  apps/gateway/src/domain/conversationContextStore.test.ts
git commit -m "feat: add conversation context storage"
```

---

### Task 2: Agents SDK Session Plumbing

**Files:**
- Create: `apps/gateway/src/runtime/conversationSession.ts`
- Create: `apps/gateway/src/runtime/conversationSession.test.ts`
- Modify: `packages/agent-runtime/src/runner.ts`
- Modify: `apps/gateway/src/runtime/openaiLlm.ts`
- Modify: `apps/gateway/src/runtime/openaiLlm.test.ts`
- Modify: `apps/gateway/src/runtime/runOrchestrator.ts`
- Modify: `apps/gateway/src/runtime/runOrchestrator.test.ts`

- [ ] **Step 1: Write failing `VultureConversationSession` tests**

Create `apps/gateway/src/runtime/conversationSession.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { ConversationContextStore } from "../domain/conversationContextStore";
import { VultureConversationSession } from "./conversationSession";

describe("VultureConversationSession", () => {
  test("implements SDK Session against ConversationContextStore", async () => {
    const items: unknown[] = [];
    const store = {
      listSessionItems: mock(() => items.map((item, index) => ({ id: `i-${index}`, item }))),
      addSessionItems: mock((_conversationId: string, added: Array<{ item: unknown }>) => {
        items.push(...added.map((entry) => entry.item));
      }),
      popSessionItem: mock(() => {
        const item = items.pop();
        return item ? { item } : undefined;
      }),
      clearSession: mock(() => {
        items.length = 0;
      }),
    } as unknown as ConversationContextStore;

    const session = new VultureConversationSession(store, "c-1");
    expect(await session.getSessionId()).toBe("c-1");

    await session.addItems([{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
    expect(await session.getItems()).toHaveLength(1);
    expect(await session.popItem()).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] });
    await session.clearSession();

    expect(store.addSessionItems).toHaveBeenCalledWith("c-1", [
      { messageId: null, role: "unknown", item: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    ]);
  });
});
```

- [ ] **Step 2: Run session test to verify it fails**

Run: `bun test apps/gateway/src/runtime/conversationSession.test.ts`

Expected: FAIL because `conversationSession.ts` does not exist.

- [ ] **Step 3: Implement `VultureConversationSession`**

Create `apps/gateway/src/runtime/conversationSession.ts`:

```ts
import type { AgentInputItem, Session } from "@openai/agents";
import type { ConversationContextStore } from "../domain/conversationContextStore";

export class VultureConversationSession implements Session {
  constructor(
    private readonly store: ConversationContextStore,
    private readonly conversationId: string,
  ) {}

  async getSessionId(): Promise<string> {
    return this.conversationId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.store.listSessionItems(this.conversationId, limit).map((item) => item.item);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.store.addSessionItems(
      this.conversationId,
      items.map((item) => ({
        messageId: null,
        role: roleFromItem(item),
        item,
      })),
    );
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.store.popSessionItem(this.conversationId)?.item;
  }

  async clearSession(): Promise<void> {
    this.store.clearSession(this.conversationId);
  }
}

function roleFromItem(item: AgentInputItem): string {
  if (typeof item === "object" && item && "role" in item && typeof item.role === "string") {
    return item.role;
  }
  return "unknown";
}
```

- [ ] **Step 4: Run session test to verify it passes**

Run: `bun test apps/gateway/src/runtime/conversationSession.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing LLM plumbing tests**

Add to `apps/gateway/src/runtime/openaiLlm.test.ts`:

```ts
test("passes session and sessionInputCallback through runFactory input", async () => {
  const seen: unknown[] = [];
  const session = { getSessionId: async () => "c-1", getItems: async () => [], addItems: async () => {}, popItem: async () => undefined, clearSession: async () => {} };
  const sessionInputCallback = () => [];
  const llm = makeOpenAILlm({
    apiKey: "sk-test",
    toolNames: [],
    toolCallable: async () => "noop",
    runFactory: (input) => {
      seen.push({ session: input.session, sessionInputCallback: input.sessionInputCallback });
      return makeMockRun([{ kind: "final", text: "ok" }]);
    },
  });

  for await (const _ of llm({
    systemPrompt: "s",
    userInput: "u",
    model: "gpt-5.4",
    runId: "r",
    workspacePath: "/tmp/work",
    session,
    sessionInputCallback,
  })) {}

  expect(seen).toEqual([{ session, sessionInputCallback }]);
});
```

Add to `apps/gateway/src/runtime/runOrchestrator.test.ts`:

```ts
test("passes session data to the LLM and reports resultMessageId to success hook", async () => {
  const deps = freshDeps();
  try {
    const { conv, run, userInput } = createRunFixture(deps);
    const session = { getSessionId: async () => conv.id, getItems: async () => [], addItems: async () => {}, popItem: async () => undefined, clearSession: async () => {} };
    const sessionInputCallback = () => [];
    const seen: unknown[] = [];
    const hookCalls: Array<{ resultMessageId: string }> = [];
    const llm: LlmCallable = mock(async function* (input: Parameters<LlmCallable>[0]) {
      seen.push({ session: input.session, sessionInputCallback: input.sessionInputCallback });
      yield { kind: "final", text: "ok" };
    });

    await orchestrateRun(
      {
        runs: deps.runs,
        messages: deps.messages,
        conversations: deps.conversations,
        llm,
        tools: async () => ({}),
        cancelSignals: new Map(),
        afterRunSucceeded: async (input) => {
          hookCalls.push({ resultMessageId: input.resultMessageId });
        },
      },
      {
        runId: run.id,
        agentId: "a-1",
        model: "gpt-5.4",
        systemPrompt: "main",
        conversationId: conv.id,
        userInput,
        workspacePath: "/tmp/work",
        session,
        sessionInputCallback,
      },
    );

    expect(seen).toEqual([{ session, sessionInputCallback }]);
    expect(hookCalls[0]?.resultMessageId).toMatch(/^m-/);
  } finally {
    deps.cleanup();
  }
});
```

- [ ] **Step 6: Run LLM/orchestrator tests to verify they fail**

Run:

```bash
bun test apps/gateway/src/runtime/openaiLlm.test.ts --test-name-pattern "session"
bun test apps/gateway/src/runtime/runOrchestrator.test.ts --test-name-pattern "session data"
```

Expected: FAIL because the types and pass-through fields do not exist.

- [ ] **Step 7: Extend shared LLM types and pass fields through**

Modify `packages/agent-runtime/src/runner.ts`:

```ts
import type { Session, SessionInputCallback } from "@openai/agents";
```

Add to `LlmCallable` input and `RunConversationArgs`:

```ts
session?: Session;
sessionInputCallback?: SessionInputCallback;
```

Pass both in `args.llm({ ... })`.

Modify `apps/gateway/src/runtime/openaiLlm.ts` imports:

```ts
  Session,
  SessionInputCallback,
```

Add to `RunFactoryInput`:

```ts
session?: Session;
sessionInputCallback?: SessionInputCallback;
```

Add in `makeOpenAILlm` factory input:

```ts
session: input.session,
sessionInputCallback: input.sessionInputCallback,
```

Add to `runner.run` options in `defaultRunFactory`:

```ts
session: input.session,
sessionInputCallback: input.sessionInputCallback,
```

Modify `apps/gateway/src/runtime/runOrchestrator.ts`:

```ts
import type { Session, SessionInputCallback } from "@openai/agents";
```

Add to `OrchestrateArgs`:

```ts
session?: Session;
sessionInputCallback?: SessionInputCallback;
```

Pass to `runConversation`.

Add `resultMessageId: string` to `afterRunSucceeded` input type and call:

```ts
resultMessageId: assistantMsg.id,
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
bun test apps/gateway/src/runtime/conversationSession.test.ts \
  apps/gateway/src/runtime/openaiLlm.test.ts \
  apps/gateway/src/runtime/runOrchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-runtime/src/runner.ts \
  apps/gateway/src/runtime/conversationSession.ts \
  apps/gateway/src/runtime/conversationSession.test.ts \
  apps/gateway/src/runtime/openaiLlm.ts \
  apps/gateway/src/runtime/openaiLlm.test.ts \
  apps/gateway/src/runtime/runOrchestrator.ts \
  apps/gateway/src/runtime/runOrchestrator.test.ts
git commit -m "feat: wire conversation sessions into runs"
```

---

### Task 3: Context Shaping Policy

**Files:**
- Create: `apps/gateway/src/runtime/conversationContext.ts`
- Create: `apps/gateway/src/runtime/conversationContext.test.ts`

- [ ] **Step 1: Write failing context shaping tests**

Create `apps/gateway/src/runtime/conversationContext.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents";
import { buildConversationSessionInputCallback, estimateSessionTextChars, shouldCompactConversation } from "./conversationContext";

function msg(role: "user" | "assistant", text: string, id = text): AgentInputItem {
  return { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], providerData: { messageId: id } } as AgentInputItem;
}

describe("conversationContext", () => {
  test("injects summary, keeps recent raw history, and appends new items", async () => {
    const callback = buildConversationSessionInputCallback({
      getContext: () => ({
        conversationId: "c-1",
        agentId: "a-1",
        summary: "Earlier: project code is alpha-17.",
        summarizedThroughMessageId: "m-2",
        inputItemCount: 8,
        inputCharCount: 800,
        createdAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
      }),
      recentMessageLimit: 2,
    });

    const shaped = await callback(
      [msg("user", "old", "m-1"), msg("assistant", "old reply", "m-2"), msg("user", "recent", "m-3")],
      [msg("user", "what is project code?", "m-4")],
    );

    expect(JSON.stringify(shaped)).toContain("Conversation context summary");
    expect(JSON.stringify(shaped)).not.toContain("old reply");
    expect(JSON.stringify(shaped)).toContain("recent");
    expect(JSON.stringify(shaped)).toContain("what is project code?");
  });

  test("falls back to recent history plus new items when context lookup fails", async () => {
    const callback = buildConversationSessionInputCallback({
      getContext: () => {
        throw new Error("db unavailable");
      },
      recentMessageLimit: 1,
    });

    const shaped = await callback([msg("user", "older"), msg("assistant", "recent")], [msg("user", "new")]);

    expect(JSON.stringify(shaped)).toContain("recent");
    expect(JSON.stringify(shaped)).toContain("new");
    expect(JSON.stringify(shaped)).not.toContain("older");
  });

  test("estimates chars and triggers compaction by count or character threshold", () => {
    const items = Array.from({ length: 13 }, (_, index) => msg("user", `message ${index}`));
    expect(estimateSessionTextChars(items)).toBeGreaterThan(50);
    expect(shouldCompactConversation({ items, maxRawMessages: 12, maxRawChars: 24_000 })).toBe(true);
    expect(shouldCompactConversation({ items: [msg("user", "short")], maxRawMessages: 12, maxRawChars: 3 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run context tests to verify they fail**

Run: `bun test apps/gateway/src/runtime/conversationContext.test.ts`

Expected: FAIL because `conversationContext.ts` does not exist.

- [ ] **Step 3: Implement context shaping**

Create `apps/gateway/src/runtime/conversationContext.ts`:

```ts
import type { AgentInputItem, SessionInputCallback } from "@openai/agents";
import type { ConversationContext } from "../domain/conversationContextStore";

export interface BuildConversationSessionInputCallbackOptions {
  getContext: () => ConversationContext | null;
  recentMessageLimit?: number;
}

export function buildConversationSessionInputCallback(
  opts: BuildConversationSessionInputCallbackOptions,
): SessionInputCallback {
  const recentLimit = opts.recentMessageLimit ?? 6;
  return async (historyItems, newItems) => {
    let context: ConversationContext | null = null;
    try {
      context = opts.getContext();
    } catch {
      context = null;
    }
    const recent = recentItemsAfterSummary(historyItems, context?.summarizedThroughMessageId).slice(-recentLimit);
    const prefix = context?.summary.trim() ? [summaryItem(context.summary)] : [];
    return [...prefix, ...recent, ...newItems];
  };
}

export function shouldCompactConversation(input: {
  items: readonly AgentInputItem[];
  maxRawMessages?: number;
  maxRawChars?: number;
}): boolean {
  const maxRawMessages = input.maxRawMessages ?? 12;
  const maxRawChars = input.maxRawChars ?? 24_000;
  return input.items.length > maxRawMessages || estimateSessionTextChars(input.items) > maxRawChars;
}

export function estimateSessionTextChars(items: readonly AgentInputItem[]): number {
  return items.reduce((sum, item) => sum + textFromItem(item).length, 0);
}

export function textFromItem(item: AgentInputItem): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const content = "content" in item ? item.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function messageIdFromItem(item: AgentInputItem): string | null {
  if (!item || typeof item !== "object") return null;
  const providerData = "providerData" in item ? item.providerData : undefined;
  if (!providerData || typeof providerData !== "object") return null;
  const value = (providerData as { messageId?: unknown }).messageId;
  return typeof value === "string" ? value : null;
}

function recentItemsAfterSummary(items: readonly AgentInputItem[], summarizedThroughMessageId?: string | null): AgentInputItem[] {
  if (!summarizedThroughMessageId) return [...items];
  const index = items.findIndex((item) => messageIdFromItem(item) === summarizedThroughMessageId);
  return index >= 0 ? items.slice(index + 1) : [...items];
}

function summaryItem(summary: string): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: [
        "Conversation context summary:",
        "<summary>",
        summary.trim(),
        "</summary>",
        "",
        "Recent conversation turns follow after this summary. Treat recent turns as more specific when they conflict with the summary.",
      ].join("\n"),
    }],
  } as AgentInputItem;
}
```

- [ ] **Step 4: Run context tests**

Run: `bun test apps/gateway/src/runtime/conversationContext.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/conversationContext.ts apps/gateway/src/runtime/conversationContext.test.ts
git commit -m "feat: add conversation context shaping"
```

---

### Task 4: Best-Effort Compactor

**Files:**
- Create: `apps/gateway/src/runtime/conversationCompactor.ts`
- Create: `apps/gateway/src/runtime/conversationCompactor.test.ts`

- [ ] **Step 1: Write failing compactor tests**

Create `apps/gateway/src/runtime/conversationCompactor.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents";
import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";
import { compactConversationContext } from "./conversationCompactor";

function msg(role: "user" | "assistant", text: string, id: string): AgentInputItem {
  return { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], providerData: { messageId: id } } as AgentInputItem;
}

describe("compactConversationContext", () => {
  test("summarizes older items and updates context through the cutoff message", async () => {
    const upserts: unknown[] = [];
    const llm: LlmCallable = mock(async function* (input: Parameters<LlmCallable>[0]): AsyncGenerator<LlmYield> {
      expect(input.systemPrompt).toContain("Summarize the older part");
      expect(input.userInput).toContain("alpha-17");
      yield { kind: "final", text: "Project code is alpha-17." };
    });

    await compactConversationContext({
      conversationId: "c-1",
      agentId: "a-1",
      model: "gpt-5.4",
      workspacePath: "/tmp/work",
      items: [
        msg("user", "project code is alpha-17", "m-1"),
        msg("assistant", "noted", "m-2"),
        msg("user", "recent 1", "m-3"),
        msg("assistant", "recent 2", "m-4"),
      ],
      recentMessageLimit: 2,
      llm,
      existingSummary: "",
      upsertContext: (input) => upserts.push(input),
    });

    expect(upserts).toEqual([
      expect.objectContaining({
        conversationId: "c-1",
        agentId: "a-1",
        summary: "Project code is alpha-17.",
        summarizedThroughMessageId: "m-2",
      }),
    ]);
  });

  test("does not update context when summarization fails", async () => {
    const upsert = mock(() => undefined);
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield> {
      throw new Error("model down");
    });

    await compactConversationContext({
      conversationId: "c-1",
      agentId: "a-1",
      model: "gpt-5.4",
      workspacePath: "/tmp/work",
      items: [msg("user", "old", "m-1"), msg("assistant", "recent", "m-2")],
      recentMessageLimit: 1,
      llm,
      existingSummary: "",
      upsertContext: upsert,
    });

    expect(upsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run compactor tests to verify they fail**

Run: `bun test apps/gateway/src/runtime/conversationCompactor.test.ts`

Expected: FAIL because `conversationCompactor.ts` does not exist.

- [ ] **Step 3: Implement compactor**

Create `apps/gateway/src/runtime/conversationCompactor.ts`:

```ts
import type { AgentInputItem } from "@openai/agents";
import type { LlmCallable } from "@vulture/agent-runtime";
import { estimateSessionTextChars, messageIdFromItem, textFromItem } from "./conversationContext";

export interface CompactConversationContextInput {
  conversationId: string;
  agentId: string;
  model: string;
  workspacePath: string;
  items: readonly AgentInputItem[];
  recentMessageLimit?: number;
  existingSummary: string;
  llm: LlmCallable;
  upsertContext: (input: {
    conversationId: string;
    agentId: string;
    summary: string;
    summarizedThroughMessageId: string | null;
    inputItemCount: number;
    inputCharCount: number;
  }) => void;
}

export async function compactConversationContext(input: CompactConversationContextInput): Promise<void> {
  const recentLimit = input.recentMessageLimit ?? 6;
  const older = input.items.slice(0, Math.max(0, input.items.length - recentLimit));
  if (older.length === 0) return;

  const cutoff = older[older.length - 1];
  const cutoffMessageId = messageIdFromItem(cutoff);
  const prompt = buildSummarizerInput(input.existingSummary, older);
  if (!prompt.trim()) return;

  let text = "";
  try {
    for await (const event of input.llm({
      runId: `context-${input.conversationId}-${crypto.randomUUID()}`,
      model: input.model,
      systemPrompt: [
        "Summarize the older part of this conversation for future turns.",
        "Preserve stable user goals, constraints, preferences, decisions, pending tasks, and important results.",
        "Do not include generic pleasantries.",
        "Do not invent facts.",
        "Return concise Markdown, maximum 2,000 characters.",
      ].join("\n"),
      userInput: prompt,
      workspacePath: input.workspacePath,
    })) {
      if (event.kind === "text.delta") text += event.text;
      if (event.kind === "final") text = event.text || text;
      if (event.kind === "tool.plan" || event.kind === "await.tool") return;
    }
  } catch {
    return;
  }

  const summary = truncateSummary(text.trim());
  if (!summary) return;
  input.upsertContext({
    conversationId: input.conversationId,
    agentId: input.agentId,
    summary,
    summarizedThroughMessageId: cutoffMessageId,
    inputItemCount: input.items.length,
    inputCharCount: estimateSessionTextChars(input.items),
  });
}

function buildSummarizerInput(existingSummary: string, older: readonly AgentInputItem[]): string {
  return [
    existingSummary.trim() ? `Existing summary:\n${existingSummary.trim()}` : "Existing summary:\n(none)",
    "",
    "Older messages:",
    ...older.map((item, index) => {
      const role = typeof item === "object" && item && "role" in item ? String(item.role) : "unknown";
      return `[#${index + 1} ${role}]\n${textFromItem(item)}`;
    }),
  ].join("\n");
}

function truncateSummary(value: string): string {
  return value.length <= 2_000 ? value : value.slice(0, 2_000);
}
```

- [ ] **Step 4: Run compactor tests**

Run: `bun test apps/gateway/src/runtime/conversationCompactor.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/runtime/conversationCompactor.ts apps/gateway/src/runtime/conversationCompactor.test.ts
git commit -m "feat: add conversation context compactor"
```

---

### Task 5: Route Integration, Context API, And Full Verification

**Files:**
- Modify: `apps/gateway/src/routes/runs.ts`
- Modify: `apps/gateway/src/routes/runs.test.ts`
- Modify: `apps/gateway/src/routes/conversations.ts`
- Modify: `apps/gateway/src/routes/conversations.test.ts`
- Modify: `apps/gateway/src/server.ts`

- [ ] **Step 1: Write failing route tests**

Modify the `fresh()` helper in `apps/gateway/src/routes/conversations.test.ts` to construct `ConversationContextStore` and pass it to the router after the router deps are extended.

Add tests:

```ts
test("GET /:id/context returns conversation context", async () => {
  const { app, convs, contexts, cleanup } = fresh();
  try {
    const c = convs.create({ agentId: "a-1" });
    contexts.upsertContext({
      conversationId: c.id,
      agentId: "a-1",
      summary: "Project code is alpha-17.",
      summarizedThroughMessageId: "m-1",
      inputItemCount: 3,
      inputCharCount: 100,
    });

    const res = await app.request(`/v1/conversations/${c.id}/context`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      conversationId: c.id,
      summary: "Project code is alpha-17.",
      summarizedThroughMessageId: "m-1",
    });
  } finally {
    cleanup();
  }
});

test("DELETE removes context rows", async () => {
  const { app, convs, contexts, cleanup } = fresh();
  try {
    const c = convs.create({ agentId: "a-1" });
    contexts.upsertContext({
      conversationId: c.id,
      agentId: "a-1",
      summary: "summary",
      summarizedThroughMessageId: null,
      inputItemCount: 0,
      inputCharCount: 0,
    });

    await app.request(`/v1/conversations/${c.id}`, { method: "DELETE", headers: auth });

    expect(contexts.getContext(c.id)).toBeNull();
  } finally {
    cleanup();
  }
});
```

Add to `apps/gateway/src/routes/runs.test.ts`:

```ts
test("POST run stores user session item and passes conversation session to orchestrator", async () => {
  const seen: unknown[] = [];
  const contextItems: unknown[] = [];
  const { app, c, contexts, cleanup } = fresh({
    llm: async function* (input) {
      seen.push({ session: input.session, sessionInputCallback: input.sessionInputCallback });
      yield { kind: "final", text: "ok" };
    },
  });
  try {
    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ctx-1" },
      body: JSON.stringify({ input: "项目代号是 alpha-17" }),
    });
    expect(res.status).toBe(202);
    await waitForCondition(() => seen.length === 1);

    expect(contexts.listSessionItems(c.id).map((item) => item.role)).toContain("user");
    expect(seen[0]).toMatchObject({
      session: expect.any(Object),
      sessionInputCallback: expect.any(Function),
    });
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run route tests to verify they fail**

Run:

```bash
bun test apps/gateway/src/routes/conversations.test.ts --test-name-pattern "context"
bun test apps/gateway/src/routes/runs.test.ts --test-name-pattern "session item"
```

Expected: FAIL because routes do not accept context store or sessions yet.

- [ ] **Step 3: Integrate context store into conversations route**

Modify `apps/gateway/src/routes/conversations.ts`:

```ts
import { ConversationContextStore } from "../domain/conversationContextStore";
```

Add optional dep:

```ts
contexts?: ConversationContextStore;
```

Add route before `/:id/messages`:

```ts
app.get("/v1/conversations/:id/context", (c) => {
  const id = c.req.param("id");
  const conv = deps.conversations.get(id);
  if (!conv) return c.json({ code: "conversation.not_found", message: id }, 404);
  const context = deps.contexts?.getContext(id);
  return c.json({
    conversationId: id,
    summary: context?.summary ?? "",
    summarizedThroughMessageId: context?.summarizedThroughMessageId ?? null,
    rawItemCount: deps.contexts?.listSessionItems(id).length ?? 0,
    updatedAt: context?.updatedAt ?? null,
  });
});
```

Update delete:

```ts
deps.contexts?.deleteConversation(c.req.param("id"));
deps.conversations.delete(c.req.param("id"));
```

- [ ] **Step 4: Integrate context into runs route**

Modify `apps/gateway/src/routes/runs.ts` imports:

```ts
import { ConversationContextStore } from "../domain/conversationContextStore";
import { VultureConversationSession } from "../runtime/conversationSession";
import { buildConversationSessionInputCallback, shouldCompactConversation } from "../runtime/conversationContext";
import { compactConversationContext } from "../runtime/conversationCompactor";
```

Extend `RunsDeps`:

```ts
contexts?: ConversationContextStore;
noToolsLlm?: LlmCallable;
```

After `userMsg` is loaded, append current user session item:

```ts
deps.contexts?.addSessionItems(cid, [{
  messageId: userMsg.id,
  role: "user",
  item: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: sessionTextForUserMessage(userMsg) }],
    providerData: { messageId: userMsg.id },
  } as never,
}]);
```

Before `orchestrateRun`, build session fields:

```ts
const session = deps.contexts ? new VultureConversationSession(deps.contexts, cid) : undefined;
const sessionInputCallback = deps.contexts
  ? buildConversationSessionInputCallback({
      getContext: () => deps.contexts?.getContext(cid) ?? null,
    })
  : undefined;
```

Pass into `orchestrateRun`.

Wrap `afterRunSucceeded` so the assistant item is persisted and compaction is scheduled:

```ts
afterRunSucceeded: async (input) => {
  if (deps.contexts) {
    deps.contexts.addSessionItems(cid, [{
      messageId: input.resultMessageId,
      role: "assistant",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: input.finalText }],
        providerData: { messageId: input.resultMessageId },
      } as never,
    }]);
    const items = deps.contexts.listSessionItems(cid).map((item) => item.item);
    if (deps.noToolsLlm && shouldCompactConversation({ items })) {
      void compactConversationContext({
        conversationId: cid,
        agentId: conv.agentId,
        model: deps.modelForAgent({ id: conv.agentId }),
        workspacePath: deps.workspacePathForAgent({ id: conv.agentId }),
        items,
        existingSummary: deps.contexts.getContext(cid)?.summary ?? "",
        llm: deps.noToolsLlm,
        upsertContext: (context) => deps.contexts?.upsertContext(context),
      });
    }
  }
  await deps.afterRunSucceeded?.(input);
},
```

Add helper:

```ts
function sessionTextForUserMessage(message: { content: string; attachments?: MessageAttachment[] }): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return message.content;
  return [
    message.content,
    "",
    "Attachments:",
    ...attachments.map((attachment) => `- ${attachment.displayName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`),
  ].join("\n");
}
```

- [ ] **Step 5: Wire server**

Modify `apps/gateway/src/server.ts`:

```ts
import { ConversationContextStore } from "./domain/conversationContextStore";
```

Instantiate:

```ts
const conversationContextStore = new ConversationContextStore(db);
```

Create no-tools LLM after `llm` setup:

```ts
const noToolsLlm = makeLazyLlm({
  toolNames: [],
  toolCallable: tools,
  approvalCallable,
  mcpToolProvider: async () => [],
  shellCallbackUrl: cfg.shellCallbackUrl,
  shellToken: cfg.token,
});
```

Pass `contexts` to `conversationsRouter` and `runsRouter`, and pass `noToolsLlm` to `runsRouter`.

- [ ] **Step 6: Run focused route tests**

Run:

```bash
bun test apps/gateway/src/routes/conversations.test.ts apps/gateway/src/routes/runs.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full gateway tests and typecheck**

Run:

```bash
bun test apps/gateway/src
bun --filter @vulture/gateway typecheck
```

Expected: all gateway tests pass and typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/routes/runs.ts \
  apps/gateway/src/routes/runs.test.ts \
  apps/gateway/src/routes/conversations.ts \
  apps/gateway/src/routes/conversations.test.ts \
  apps/gateway/src/server.ts
git commit -m "feat: enable conversation context management"
```

---

## Final Verification

- [ ] Run gateway tests:

```bash
bun test apps/gateway/src
```

- [ ] Run gateway typecheck:

```bash
bun --filter @vulture/gateway typecheck
```

- [ ] Run desktop UI tests to catch protocol/UI regressions:

```bash
bun test apps/desktop-ui/src
```

- [ ] Run desktop UI typecheck:

```bash
bun --filter @vulture/desktop-ui typecheck
```

- [ ] Manual verification:

```text
1. Start Vulture.
2. Open a new conversation.
3. Send: 项目代号是 alpha-17，请记住本轮对话里会用到。
4. Send: 项目代号是什么？请简单回答。
5. Expected: alpha-17.
6. Send more than 12 short turns.
7. Ask again: 项目代号是什么？请简单回答。
8. Expected: alpha-17.
9. Open a new conversation.
10. Ask: 项目代号是什么？请简单回答。
11. Expected: it does not know alpha-17.
```

## Self-Review Notes

- Spec coverage: storage, SDK session, recent raw turns, summary compaction, local-only state, memory separation, no-tools summarization, route introspection, failure fallback, and isolation are all mapped to tasks.
- Type consistency: `ConversationContextStore`, `VultureConversationSession`, `buildConversationSessionInputCallback`, and `compactConversationContext` are introduced before integration tasks use them.
- Scope control: no UI management page, no server-managed OpenAI conversation state, and no binary attachment summarization are included.
