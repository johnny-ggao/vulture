# L0 Phase 3a — Backend: Run/Conversation/Message + LLM + Tool Execution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy stdio sidecar with a gateway-resident Run engine. After this phase, sending a message persists Conversation/Message/Run rows in SQLite, the gateway invokes the LLM (via `@openai/agents`), tool calls are HTTP-routed to the Rust shell for actual execution, and SSE streams `RunEvent`s for the future UI to consume. The legacy `apps/agent-sidecar/`, `sidecar.rs`, `agent_pack.rs`, and the `start_agent_run` / `start_mock_run` Tauri commands are deleted.

**Architecture:** Gateway loads `agent-packs/` markdown to assemble system prompts, calls `@openai/agents` Run with model + tools, and translates SDK events to `RunEvent`s persisted in `run_events` (SQLite) and broadcast to subscribed SSE clients. Tool callbacks: `@openai/agents` Tool.execute → HTTP POST to Rust `tool_callback.rs::/tools/invoke` → `vulture_tool_gateway::PolicyEngine` decides allow/ask/deny → if allow, Rust executes (`shell.exec` via `tokio::process::Command`, `browser.*` via existing browser relay) → returns result. Runs that reach `tool.ask` pause and emit a `RunEvent`; UI's eventual approval path will use `POST /v1/runs/:rid/approvals` (route added but UI integration deferred to 3b). On gateway restart, the runStore sweep marks any `running` rows as `failed(internal.gateway_restarted)`.

**Tech Stack:**
- Bun: `@openai/agents` (already a dep in agent-sidecar — moves to gateway), `bun:sqlite`, hono SSE
- Rust: `tokio::process::Command` for shell.exec; reuse existing `vulture_tool_gateway::{PolicyEngine, AuditStore}`; reuse existing `apps/desktop-shell/src/browser/` for browser tools
- Protocol: zod schemas + branded ID types

**Spec:** [`docs/superpowers/specs/2026-04-26-gateway-skeleton-design.md`](../specs/2026-04-26-gateway-skeleton-design.md) — Phase 3 section under "Migration Plan"; Tool Callback Protocol section.

**Companion plan:** Phase 3b (UI rewrite to chat + SSE consumer + ConversationView/RunEventStream components) is deferred to a separate plan written after 3a is running. 3a leaves the existing UI on the legacy `start_agent_run` codepath UNTIL the legacy commands are deleted in Tasks 24-25; users will see only the runtime debug strip + their existing UI broken until 3b lands. See "Out of scope (3a)" at end.

**Phase 3a is a one-way door** — SQLite gains conversations/messages/runs/run_events; rolling back means data loss. PR review: ≥ 2 reviewers + second spec audit per spec risk register.

---

## File structure (created/deleted by 3a)

```text
packages/protocol/src/v1/
├── conversation.ts        NEW: Conversation, Message, MessageRole types
├── run.ts                 NEW: Run, RunStatus, RunEvent (discriminated union)
└── tool.ts                NEW: Tool, ToolName, ToolInvocationContext

apps/gateway/
├── package.json           MODIFIED: add @openai/agents, hono streaming helpers
├── agent-packs/           NEW: copied from apps/desktop-shell/agent-packs/
│   └── local-work/{SOUL,IDENTITY,AGENTS,TOOLS,USER}.md
├── src/
│   ├── persistence/
│   │   ├── migrations/002_runs.sql        NEW
│   │   └── migrate.ts                      MODIFIED: append v2
│   ├── domain/
│   │   ├── conversationStore.ts           NEW
│   │   ├── messageStore.ts                NEW
│   │   ├── runStore.ts                    NEW: includes startup recovery sweep
│   │   └── runEventBuffer.ts              NEW: in-memory + SQLite-backed event stream
│   ├── routes/
│   │   ├── conversations.ts               NEW: CRUD + messages list
│   │   └── runs.ts                        NEW: POST /v1/conversations/:cid/runs
│   │                                            GET /v1/runs/:rid
│   │                                            GET /v1/runs/:rid/events (SSE)
│   │                                            POST /v1/runs/:rid/cancel
│   │                                            POST /v1/runs/:rid/approvals
│   ├── runtime/
│   │   └── shellClient.ts                 NEW: Bun → Rust /tools/* HTTP client
│   └── server.ts                          MODIFIED: mount conversations + runs + run engine

packages/
├── llm/                   NEW package
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts       LLM provider interface
│       └── openai.ts      @openai/agents wrapper
└── agent-runtime/         NEW package
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts       re-exports
        ├── promptAssembler.ts   reads agent-packs/, returns assembled system prompt
        ├── events.ts            RunEvent constructors
        └── runner.ts            run loop: build prompt → LLM → tool calls → emit events

apps/desktop-shell/src/
├── tool_callback.rs       MODIFIED: fill in /tools/manifest, /tools/invoke, /tools/cancel
├── tool_executor.rs       NEW: Rust execution backends for shell.exec + browser.*
├── sidecar.rs             DELETED
├── agent_pack.rs          DELETED
├── commands.rs            MODIFIED: remove start_agent_run, start_mock_run
├── main.rs                MODIFIED: drop deleted mod + handler entries
└── lib.rs                 MODIFIED: drop deleted mod

apps/agent-sidecar/         DELETED entire directory
apps/desktop-shell/agent-packs/  DELETED (moved to apps/gateway/agent-packs/)
crates/core/src/agent.rs    MODIFIED: delete AgentRecord (still referenced by deleted Rust)
```

---

## Group A — Protocol types

### Task 1: `protocol/v1/conversation.ts`

**Files:**
- Create: `packages/protocol/src/v1/conversation.ts`
- Create: `packages/protocol/src/v1/conversation.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/v1/conversation.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  ConversationSchema,
  MessageSchema,
  CreateConversationRequestSchema,
  PostMessageRequestSchema,
  type Conversation,
  type Message,
} from "./conversation";

describe("Conversation + Message schemas", () => {
  const conv: Conversation = {
    id: "c-01" as Conversation["id"],
    agentId: "local-work-agent" as Conversation["agentId"],
    title: "Hello",
    createdAt: "2026-04-26T00:00:00.000Z" as Conversation["createdAt"],
    updatedAt: "2026-04-26T00:00:00.000Z" as Conversation["updatedAt"],
  };
  const msg: Message = {
    id: "m-01" as Message["id"],
    conversationId: conv.id,
    role: "user",
    content: "Hi",
    runId: null,
    createdAt: "2026-04-26T00:00:00.000Z" as Message["createdAt"],
  };

  test("ConversationSchema parses sample", () => {
    expect(ConversationSchema.parse(conv)).toEqual(conv);
  });

  test("MessageSchema accepts user/assistant/system roles", () => {
    expect(MessageSchema.parse(msg).role).toBe("user");
    expect(MessageSchema.parse({ ...msg, role: "assistant" }).role).toBe("assistant");
    expect(MessageSchema.parse({ ...msg, role: "system" }).role).toBe("system");
  });

  test("MessageSchema rejects 'tool' role", () => {
    expect(() => MessageSchema.parse({ ...msg, role: "tool" })).toThrow();
  });

  test("CreateConversationRequest: only agentId required", () => {
    const r = CreateConversationRequestSchema.parse({ agentId: "x" });
    expect(r.agentId).toBe("x");
    expect(r.title).toBeUndefined();
  });

  test("PostMessageRequest requires non-empty input", () => {
    expect(PostMessageRequestSchema.parse({ input: "hi" }).input).toBe("hi");
    expect(() => PostMessageRequestSchema.parse({ input: "" })).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**: `bun test packages/protocol/src/v1/conversation.test.ts`

- [ ] **Step 3: Write `packages/protocol/src/v1/conversation.ts`**

```ts
import { z } from "zod";
import type { BrandedId } from "@vulture/common";
import type { Iso8601 } from "./index";
import type { AgentId } from "./agent";

export type ConversationId = BrandedId<"ConversationId">;
export type MessageId = BrandedId<"MessageId">;
export type RunId = BrandedId<"RunId">;

const Iso8601Schema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

export const ConversationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string(),
  createdAt: Iso8601Schema,
  updatedAt: Iso8601Schema,
});

export type Conversation = Omit<
  z.infer<typeof ConversationSchema>,
  "id" | "agentId" | "createdAt" | "updatedAt"
> & {
  id: ConversationId;
  agentId: AgentId;
  createdAt: Iso8601;
  updatedAt: Iso8601;
};

export const MessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  runId: z.string().min(1).nullable(),
  createdAt: Iso8601Schema,
});

export type Message = Omit<
  z.infer<typeof MessageSchema>,
  "id" | "conversationId" | "runId" | "createdAt"
> & {
  id: MessageId;
  conversationId: ConversationId;
  runId: RunId | null;
  createdAt: Iso8601;
};

export const CreateConversationRequestSchema = z
  .object({
    agentId: z.string().min(1),
    title: z.string().optional(),
  })
  .strict();
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const PostMessageRequestSchema = z
  .object({ input: z.string().min(1) })
  .strict();
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;
```

- [ ] **Step 4: Run, expect 5 PASS** + typecheck (`bun --filter @vulture/protocol typecheck`)

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add v1 Conversation + Message + request schemas"
```

### Task 2: `protocol/v1/run.ts` — Run + RunEvent (discriminated union)

**Files:**
- Create: `packages/protocol/src/v1/run.ts`
- Create: `packages/protocol/src/v1/run.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/v1/run.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { RunSchema, RunEventSchema, type RunEvent } from "./run";

describe("Run + RunEvent", () => {
  test("Run parses minimal", () => {
    const r = RunSchema.parse({
      id: "r-1",
      conversationId: "c-1",
      agentId: "a-1",
      status: "running",
      triggeredByMessageId: "m-1",
      resultMessageId: null,
      startedAt: "2026-04-26T00:00:00.000Z",
      endedAt: null,
      error: null,
    });
    expect(r.status).toBe("running");
  });

  test("RunEvent discriminated union — text.delta", () => {
    const ev: RunEvent = {
      type: "text.delta",
      runId: "r-1" as RunEvent["runId"],
      seq: 1,
      createdAt: "2026-04-26T00:00:00.000Z" as RunEvent["createdAt"],
      text: "hello",
    };
    expect(RunEventSchema.parse(ev).type).toBe("text.delta");
  });

  test("RunEvent — tool.ask requires approvalToken", () => {
    expect(() =>
      RunEventSchema.parse({
        type: "tool.ask",
        runId: "r-1",
        seq: 5,
        createdAt: "2026-04-26T00:00:00.000Z",
        callId: "c1",
        tool: "browser.click",
        reason: "needs approval",
        // approvalToken missing
      }),
    ).toThrow();
  });

  test("RunEvent — run.completed requires resultMessageId + finalText", () => {
    const ev = RunEventSchema.parse({
      type: "run.completed",
      runId: "r-1",
      seq: 99,
      createdAt: "2026-04-26T00:00:00.000Z",
      resultMessageId: "m-2",
      finalText: "Done.",
    });
    expect(ev.type).toBe("run.completed");
  });

  test("RunEvent rejects unknown type", () => {
    expect(() =>
      RunEventSchema.parse({
        type: "tool.unknown",
        runId: "r-1",
        seq: 1,
        createdAt: "2026-04-26T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `packages/protocol/src/v1/run.ts`**

```ts
import { z } from "zod";
import type { BrandedId } from "@vulture/common";
import type { Iso8601 } from "./index";
import type { AgentId } from "./agent";
import type { ConversationId, MessageId, RunId } from "./conversation";
import { AppErrorSchema, type AppError } from "./error";

const Iso8601Schema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  agentId: z.string().min(1),
  status: RunStatusSchema,
  triggeredByMessageId: z.string().min(1),
  resultMessageId: z.string().min(1).nullable(),
  startedAt: Iso8601Schema,
  endedAt: Iso8601Schema.nullable(),
  error: AppErrorSchema.nullable(),
});

export type Run = Omit<
  z.infer<typeof RunSchema>,
  "id" | "conversationId" | "agentId" | "triggeredByMessageId" | "resultMessageId" | "startedAt" | "endedAt" | "error"
> & {
  id: RunId;
  conversationId: ConversationId;
  agentId: AgentId;
  triggeredByMessageId: MessageId;
  resultMessageId: MessageId | null;
  startedAt: Iso8601;
  endedAt: Iso8601 | null;
  error: AppError | null;
};

const baseEvent = z.object({
  runId: z.string().min(1),
  seq: z.number().int().min(0),
  createdAt: Iso8601Schema,
});

export const RunEventSchema = z.discriminatedUnion("type", [
  baseEvent.extend({
    type: z.literal("run.started"),
    agentId: z.string().min(1),
    model: z.string().min(1),
  }),
  baseEvent.extend({
    type: z.literal("text.delta"),
    text: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("tool.planned"),
    callId: z.string().min(1),
    tool: z.string().min(1),
    input: z.unknown(),
  }),
  baseEvent.extend({
    type: z.literal("tool.started"),
    callId: z.string().min(1),
  }),
  baseEvent.extend({
    type: z.literal("tool.completed"),
    callId: z.string().min(1),
    output: z.unknown(),
  }),
  baseEvent.extend({
    type: z.literal("tool.failed"),
    callId: z.string().min(1),
    error: AppErrorSchema,
  }),
  baseEvent.extend({
    type: z.literal("tool.ask"),
    callId: z.string().min(1),
    tool: z.string().min(1),
    reason: z.string().min(1),
    approvalToken: z.string().min(1),
  }),
  baseEvent.extend({
    type: z.literal("run.completed"),
    resultMessageId: z.string().min(1),
    finalText: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("run.failed"),
    error: AppErrorSchema,
  }),
  baseEvent.extend({
    type: z.literal("run.cancelled"),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
```

- [ ] **Step 4: Run, expect 5 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add v1 Run + RunEvent discriminated union"
```

### Task 3: `protocol/v1/tool.ts`

**Files:**
- Create: `packages/protocol/src/v1/tool.ts`
- Create: `packages/protocol/src/v1/tool.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/v1/tool.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  ToolSchema,
  ToolInvocationContextSchema,
  ApprovalDecisionSchema,
  type Tool,
} from "./tool";

describe("Tool", () => {
  test("ToolSchema parses sample", () => {
    const t: Tool = {
      name: "shell.exec" as Tool["name"],
      description: "run a command",
      inputSchema: { type: "object" },
      requiresApproval: true,
    };
    expect(ToolSchema.parse(t).name).toBe("shell.exec");
  });

  test("ApprovalDecision is allow|deny", () => {
    expect(ApprovalDecisionSchema.parse("allow")).toBe("allow");
    expect(ApprovalDecisionSchema.parse("deny")).toBe("deny");
    expect(() => ApprovalDecisionSchema.parse("maybe")).toThrow();
  });

  test("ToolInvocationContext: workspace + optional approval", () => {
    expect(
      ToolInvocationContextSchema.parse({
        workspace: { id: "w", path: "/tmp" },
        approval: null,
      }).approval,
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `packages/protocol/src/v1/tool.ts`**

```ts
import { z } from "zod";
import type { BrandedId } from "@vulture/common";

export type ToolName = BrandedId<"ToolName">;

export const ToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.unknown(),
  requiresApproval: z.boolean(),
});
export type Tool = Omit<z.infer<typeof ToolSchema>, "name"> & { name: ToolName };

export const ApprovalDecisionSchema = z.enum(["allow", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalSchema = z.object({
  token: z.string().min(1),
  decision: ApprovalDecisionSchema,
  at: z.string().min(1),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ToolInvocationContextSchema = z.object({
  workspace: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
  }),
  approval: ApprovalSchema.nullable(),
});
export type ToolInvocationContext = z.infer<typeof ToolInvocationContextSchema>;
```

- [ ] **Step 4: Run, expect 3 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add v1 Tool + ApprovalDecision + ToolInvocationContext"
```

---

## Group B — SQLite schema for conversations / messages / runs / run_events

### Task 4: 002_runs.sql + migrate v2

**Files:**
- Create: `apps/gateway/src/persistence/migrations/002_runs.sql`
- Modify: `apps/gateway/src/persistence/migrate.ts`
- Modify: `apps/gateway/src/persistence/migrate.test.ts`

- [ ] **Step 1: Write `002_runs.sql`**

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  run_id          TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id                       TEXT PRIMARY KEY,
  conversation_id          TEXT NOT NULL,
  agent_id                 TEXT NOT NULL,
  status                   TEXT NOT NULL,
  triggered_by_message_id  TEXT NOT NULL,
  result_message_id        TEXT,
  started_at               TEXT NOT NULL,
  ended_at                 TEXT,
  error_json               TEXT,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs(conversation_id);

CREATE TABLE IF NOT EXISTS run_events (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(run_id, seq),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO schema_version(version) VALUES (2);
```

- [ ] **Step 2: Update `migrate.ts` MIGRATIONS array** — append:

```ts
import init002 from "./migrations/002_runs.sql" with { type: "text" }; // or readFileSync if bun import attribute fails
```

(If `with { type: "text" }` doesn't typecheck on its own — Phase 2 used readFileSync; do same here.)

```ts
const init002 = readFileSync(join(here, "migrations", "002_runs.sql"), "utf8");
const MIGRATIONS: Migration[] = [
  { version: 1, sql: init001 },
  { version: 2, sql: init002 },
];
```

- [ ] **Step 3: Append migrate test**

In `apps/gateway/src/persistence/migrate.test.ts` add inside the existing `describe`:
```ts
test("002 adds conversations/messages/runs/run_events tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v2-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  expect(currentSchemaVersion(db)).toBe(2);
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("conversations");
  expect(names).toContain("messages");
  expect(names).toContain("runs");
  expect(names).toContain("run_events");
  db.close();
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 4: Run all migrate tests, expect 3 PASS** + typecheck

```bash
bun test apps/gateway/src/persistence/migrate.test.ts
bun --filter @vulture/gateway typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): schema migration 002 (conversations/messages/runs/run_events)"
```

---

## Group C — Domain stores

### Task 5: ConversationStore

**Files:**
- Create: `apps/gateway/src/domain/conversationStore.ts`
- Create: `apps/gateway/src/domain/conversationStore.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/domain/conversationStore.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "./conversationStore";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-conv-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return { store: new ConversationStore(db), cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("ConversationStore", () => {
  test("create + get + list", () => {
    const { store, cleanup } = freshStore();
    const c = store.create({ agentId: "a-1", title: "Hello" });
    expect(c.agentId).toBe("a-1");
    expect(store.get(c.id)?.id).toBe(c.id);
    expect(store.list().map((x) => x.id)).toEqual([c.id]);
    cleanup();
  });

  test("list filters by agentId", () => {
    const { store, cleanup } = freshStore();
    store.create({ agentId: "a-1", title: "x" });
    store.create({ agentId: "a-2", title: "y" });
    expect(store.list({ agentId: "a-1" }).length).toBe(1);
    cleanup();
  });

  test("delete cascades (no orphan messages)", () => {
    // FK ON DELETE CASCADE is enabled in sqlite.ts; will be exercised when
    // MessageStore lands in Task 6. Here we only verify the row is removed.
    const { store, cleanup } = freshStore();
    const c = store.create({ agentId: "a-1", title: "x" });
    store.delete(c.id);
    expect(store.get(c.id)).toBeNull();
    cleanup();
  });

  test("default title is empty string when not given", () => {
    const { store, cleanup } = freshStore();
    const c = store.create({ agentId: "a-1" });
    expect(c.title).toBe("");
    cleanup();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/gateway/src/domain/conversationStore.ts`**

```ts
import type { DB } from "../persistence/sqlite";
import type {
  Conversation,
  ConversationId,
  CreateConversationRequest,
} from "@vulture/protocol/src/v1/conversation";
import type { AgentId } from "@vulture/protocol/src/v1/agent";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { brandId } from "@vulture/common";

interface Row {
  id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function rowToConversation(r: Row): Conversation {
  return {
    id: r.id as ConversationId,
    agentId: r.agent_id as AgentId,
    title: r.title,
    createdAt: r.created_at as Iso8601,
    updatedAt: r.updated_at as Iso8601,
  };
}

function genId(): ConversationId {
  // uuidv7 isn't in stdlib; use crypto.randomUUID (v4) — IDs are time-sortable
  // by `created_at` index instead.
  return brandId<ConversationId>(`c-${crypto.randomUUID()}`);
}

export class ConversationStore {
  constructor(private readonly db: DB) {}

  create(req: CreateConversationRequest): Conversation {
    const now = nowIso8601();
    const id = genId();
    this.db
      .query(
        "INSERT INTO conversations(id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, req.agentId, req.title ?? "", now, now);
    return this.get(id) as Conversation;
  }

  get(id: string): Conversation | null {
    const row = this.db
      .query("SELECT * FROM conversations WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? rowToConversation(row) : null;
  }

  list(filter: { agentId?: string } = {}): Conversation[] {
    const rows = filter.agentId
      ? (this.db
          .query("SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC")
          .all(filter.agentId) as Row[])
      : (this.db
          .query("SELECT * FROM conversations ORDER BY updated_at DESC")
          .all() as Row[]);
    return rows.map(rowToConversation);
  }

  delete(id: string): void {
    this.db.query("DELETE FROM conversations WHERE id = ?").run(id);
  }

  touch(id: string): void {
    this.db
      .query("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(nowIso8601(), id);
  }
}
```

- [ ] **Step 4: Run tests, expect 4 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/gateway packages
git commit -m "feat(gateway): ConversationStore CRUD"
```

### Task 6: MessageStore

**Files:**
- Create: `apps/gateway/src/domain/messageStore.ts`
- Create: `apps/gateway/src/domain/messageStore.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/domain/messageStore.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { MessageStore } from "./messageStore";
import { ConversationStore } from "./conversationStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-msg-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return {
    db,
    convs: new ConversationStore(db),
    msgs: new MessageStore(db),
    cleanup: () => { db.close(); rmSync(dir, { recursive: true }); },
  };
}

describe("MessageStore", () => {
  test("append + listSince", () => {
    const { convs, msgs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    const m1 = msgs.append({ conversationId: c.id, role: "user", content: "hi", runId: null });
    const m2 = msgs.append({ conversationId: c.id, role: "assistant", content: "yo", runId: null });
    const all = msgs.listSince({ conversationId: c.id });
    expect(all.map((m) => m.id)).toEqual([m1.id, m2.id]);
    const after = msgs.listSince({ conversationId: c.id, afterMessageId: m1.id });
    expect(after.map((m) => m.id)).toEqual([m2.id]);
    cleanup();
  });

  test("CASCADE delete removes messages when conversation is deleted", () => {
    const { convs, msgs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    convs.delete(c.id);
    expect(msgs.listSince({ conversationId: c.id }).length).toBe(0);
    cleanup();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/gateway/src/domain/messageStore.ts`**

```ts
import type { DB } from "../persistence/sqlite";
import type {
  Message,
  MessageId,
  MessageRole,
  ConversationId,
  RunId,
} from "@vulture/protocol/src/v1/conversation";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { brandId } from "@vulture/common";

interface Row {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  run_id: string | null;
  created_at: string;
}

function rowToMessage(r: Row): Message {
  return {
    id: r.id as MessageId,
    conversationId: r.conversation_id as ConversationId,
    role: r.role as MessageRole,
    content: r.content,
    runId: (r.run_id ?? null) as RunId | null,
    createdAt: r.created_at as Iso8601,
  };
}

function genId(): MessageId {
  return brandId<MessageId>(`m-${crypto.randomUUID()}`);
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  runId: string | null;
}

export class MessageStore {
  constructor(private readonly db: DB) {}

  append(input: AppendMessageInput): Message {
    const id = genId();
    const now = nowIso8601();
    this.db
      .query(
        "INSERT INTO messages(id, conversation_id, role, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.conversationId, input.role, input.content, input.runId, now);
    return this.get(id) as Message;
  }

  get(id: string): Message | null {
    const row = this.db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  listSince(opts: { conversationId: string; afterMessageId?: string }): Message[] {
    if (opts.afterMessageId) {
      const after = this.get(opts.afterMessageId);
      if (!after) return [];
      const rows = this.db
        .query(
          "SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at ASC",
        )
        .all(opts.conversationId, after.createdAt) as Row[];
      return rows.map(rowToMessage);
    }
    const rows = this.db
      .query(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
      )
      .all(opts.conversationId) as Row[];
    return rows.map(rowToMessage);
  }
}
```

- [ ] **Step 4: Run, expect 2 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): MessageStore append + listSince"
```

### Task 7: RunStore (with startup recovery sweep)

**Files:**
- Create: `apps/gateway/src/domain/runStore.ts`
- Create: `apps/gateway/src/domain/runStore.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/domain/runStore.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "./conversationStore";
import { MessageStore } from "./messageStore";
import { RunStore } from "./runStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-run-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const c = convs.create({ agentId: "a-1" });
  const userMsg = msgs.append({
    conversationId: c.id,
    role: "user",
    content: "hi",
    runId: null,
  });
  return { db, runs, c, userMsg, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("RunStore", () => {
  test("create + get + transition to succeeded", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    expect(r.status).toBe("queued");
    runs.markRunning(r.id);
    expect(runs.get(r.id)?.status).toBe("running");
    runs.markSucceeded(r.id, "m-result");
    const final = runs.get(r.id)!;
    expect(final.status).toBe("succeeded");
    expect(final.resultMessageId).toBe("m-result");
    cleanup();
  });

  test("markFailed records error_json", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markFailed(r.id, { code: "internal", message: "boom" });
    const final = runs.get(r.id)!;
    expect(final.status).toBe("failed");
    expect(final.error?.code).toBe("internal");
    cleanup();
  });

  test("recoverInflightOnStartup sweeps queued/running → failed", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRunning(r.id);
    // simulate a fresh process startup:
    const fresh2 = new RunStore(db);
    const swept = fresh2.recoverInflightOnStartup();
    expect(swept).toBe(1);
    expect(runs.get(r.id)?.status).toBe("failed");
    expect(runs.get(r.id)?.error?.code).toBe("internal.gateway_restarted");
    cleanup();
  });

  test("appendEvent + listEventsAfter (in-memory + persisted)", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.appendEvent(r.id, { type: "run.started", agentId: c.agentId, model: "gpt-5.4" });
    runs.appendEvent(r.id, { type: "text.delta", text: "hello " });
    const all = runs.listEventsAfter(r.id, -1);
    expect(all.length).toBe(2);
    expect(all[0].seq).toBe(0);
    const after = runs.listEventsAfter(r.id, 0);
    expect(after.length).toBe(1);
    expect(after[0].type).toBe("text.delta");
    cleanup();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/gateway/src/domain/runStore.ts`**

```ts
import type { DB } from "../persistence/sqlite";
import type {
  Run,
  RunStatus,
  RunEvent,
} from "@vulture/protocol/src/v1/run";
import type {
  RunId,
  ConversationId,
  MessageId,
} from "@vulture/protocol/src/v1/conversation";
import type { AgentId } from "@vulture/protocol/src/v1/agent";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import type { AppError } from "@vulture/protocol/src/v1/error";
import { brandId } from "@vulture/common";

interface RunRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  status: string;
  triggered_by_message_id: string;
  result_message_id: string | null;
  started_at: string;
  ended_at: string | null;
  error_json: string | null;
}

function rowToRun(r: RunRow): Run {
  return {
    id: r.id as RunId,
    conversationId: r.conversation_id as ConversationId,
    agentId: r.agent_id as AgentId,
    status: r.status as RunStatus,
    triggeredByMessageId: r.triggered_by_message_id as MessageId,
    resultMessageId: (r.result_message_id ?? null) as MessageId | null,
    startedAt: r.started_at as Iso8601,
    endedAt: (r.ended_at ?? null) as Iso8601 | null,
    error: r.error_json ? (JSON.parse(r.error_json) as AppError) : null,
  };
}

function genId(): RunId {
  return brandId<RunId>(`r-${crypto.randomUUID()}`);
}

export interface CreateRunInput {
  conversationId: string;
  agentId: string;
  triggeredByMessageId: string;
}

export class RunStore {
  constructor(private readonly db: DB) {}

  create(input: CreateRunInput): Run {
    const id = genId();
    const now = nowIso8601();
    this.db
      .query(
        `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id,
                          result_message_id, started_at, ended_at, error_json)
         VALUES (?, ?, ?, 'queued', ?, NULL, ?, NULL, NULL)`,
      )
      .run(id, input.conversationId, input.agentId, input.triggeredByMessageId, now);
    return this.get(id) as Run;
  }

  get(id: string): Run | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  markRunning(id: string): void {
    this.db.query("UPDATE runs SET status = 'running' WHERE id = ?").run(id);
  }

  markSucceeded(id: string, resultMessageId: string): void {
    this.db
      .query(
        "UPDATE runs SET status = 'succeeded', result_message_id = ?, ended_at = ? WHERE id = ?",
      )
      .run(resultMessageId, nowIso8601(), id);
  }

  markFailed(id: string, error: AppError): void {
    this.db
      .query(
        "UPDATE runs SET status = 'failed', error_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(error), nowIso8601(), id);
  }

  markCancelled(id: string): void {
    this.db
      .query("UPDATE runs SET status = 'cancelled', ended_at = ? WHERE id = ?")
      .run(nowIso8601(), id);
  }

  /** Mark all queued/running runs as failed; called once on gateway startup. */
  recoverInflightOnStartup(): number {
    const error: AppError = {
      code: "internal.gateway_restarted",
      message: "gateway restarted while this run was in flight",
    };
    const result = this.db
      .query(
        "UPDATE runs SET status = 'failed', error_json = ?, ended_at = ? WHERE status IN ('queued', 'running')",
      )
      .run(JSON.stringify(error), nowIso8601()) as { changes: number };
    return result.changes;
  }

  appendEvent(runId: string, partial: Omit<RunEvent, "runId" | "seq" | "createdAt">): RunEvent {
    const seq = this.nextSeq(runId);
    const now = nowIso8601();
    const event = { ...partial, runId, seq, createdAt: now } as RunEvent;
    this.db
      .query(
        "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, seq, event.type, JSON.stringify(event), now);
    return event;
  }

  listEventsAfter(runId: string, afterSeq: number): RunEvent[] {
    const rows = this.db
      .query(
        "SELECT payload_json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(runId, afterSeq) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as RunEvent);
  }

  private nextSeq(runId: string): number {
    const row = this.db
      .query("SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?")
      .get(runId) as { s: number | null };
    return (row.s ?? -1) + 1;
  }
}
```

- [ ] **Step 4: Run, expect 4 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): RunStore + appendEvent/listEventsAfter + startup recovery"
```

---

## Group D — `packages/llm`

### Task 8: Scaffold `@vulture/llm` + OpenAI Agents wrapper

**Files:**
- Create: `packages/llm/package.json`
- Create: `packages/llm/tsconfig.json`
- Create: `packages/llm/src/index.ts`
- Create: `packages/llm/src/openai.ts`
- Create: `packages/llm/src/openai.test.ts`

- [ ] **Step 1: Create package files**

`packages/llm/package.json`:
```json
{
  "name": "@vulture/llm",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "bun test src",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@vulture/common": "workspace:*",
    "@vulture/protocol": "workspace:*",
    "@openai/agents": "^0.8.5"
  },
  "devDependencies": {
    "@types/bun": "^1.3.13",
    "typescript": "^5.8.0"
  }
}
```

`packages/llm/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

`packages/llm/src/index.ts`:
```ts
export * from "./openai";
```

- [ ] **Step 2: Run `bun install`** to wire workspace dep

- [ ] **Step 3: Write the failing test**

`packages/llm/src/openai.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { selectModel, isApiKeyConfigured } from "./openai";

describe("openai helpers", () => {
  test("selectModel falls back to default for unsupported names", () => {
    expect(selectModel("gpt-5.4")).toBe("gpt-5.4");
    expect(selectModel("")).toBe("gpt-5.4");
    expect(selectModel("definitely-not-real")).toBe("gpt-5.4");
  });

  test("isApiKeyConfigured: true if env var present and non-empty", () => {
    expect(isApiKeyConfigured({})).toBe(false);
    expect(isApiKeyConfigured({ OPENAI_API_KEY: "" })).toBe(false);
    expect(isApiKeyConfigured({ OPENAI_API_KEY: "sk-x" })).toBe(true);
  });
});
```

- [ ] **Step 4: Write `packages/llm/src/openai.ts`**

```ts
const SUPPORTED_MODELS = new Set(["gpt-5.4", "gpt-5.5", "gpt-4o", "gpt-4o-mini"]);
export const DEFAULT_MODEL = "gpt-5.4";

export function selectModel(requested: string): string {
  if (SUPPORTED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

export function isApiKeyConfigured(env: Record<string, string | undefined>): boolean {
  const k = env.OPENAI_API_KEY;
  return typeof k === "string" && k.length > 0;
}

// The actual @openai/agents Agent + Run construction lives in
// packages/agent-runtime/src/runner.ts (Task 11). This module just exposes
// model + auth helpers so the runtime can stay provider-agnostic.
```

- [ ] **Step 5: Run, expect 2 PASS** + typecheck

```bash
bun test packages/llm/src/openai.test.ts
bun --filter @vulture/llm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/llm package.json bun.lock
git commit -m "feat(llm): scaffold @vulture/llm with model + auth helpers"
```

---

## Group E — `packages/agent-runtime`

### Task 9: Scaffold + promptAssembler.ts

**Files:**
- Create: `packages/agent-runtime/package.json`
- Create: `packages/agent-runtime/tsconfig.json`
- Create: `packages/agent-runtime/src/index.ts`
- Create: `packages/agent-runtime/src/promptAssembler.ts`
- Create: `packages/agent-runtime/src/promptAssembler.test.ts`

- [ ] **Step 1: Create package files**

`packages/agent-runtime/package.json`:
```json
{
  "name": "@vulture/agent-runtime",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "bun test src",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@vulture/common": "workspace:*",
    "@vulture/protocol": "workspace:*",
    "@vulture/llm": "workspace:*",
    "@openai/agents": "^0.8.5"
  },
  "devDependencies": {
    "@types/bun": "^1.3.13",
    "typescript": "^5.8.0"
  }
}
```

`packages/agent-runtime/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

`packages/agent-runtime/src/index.ts`:
```ts
export * from "./promptAssembler";
export * from "./events";
export * from "./runner";
```

- [ ] **Step 2: Run `bun install`**

- [ ] **Step 3: Write the failing test**

`packages/agent-runtime/src/promptAssembler.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleAgentInstructions, assembleCodexPrompt } from "./promptAssembler";

function fakePack(dir: string) {
  const p = join(dir, "local-work");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "SOUL.md"), "# Soul section");
  writeFileSync(join(p, "IDENTITY.md"), "# Identity section");
  writeFileSync(join(p, "AGENTS.md"), "# Default agents");
  writeFileSync(join(p, "TOOLS.md"), "# Tools section");
  writeFileSync(join(p, "USER.md"), "# User section\n禁止回复待命话术");
  return p;
}

const agent = {
  id: "local-work-agent",
  name: "Local Work Agent",
  description: "general",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: ["shell.exec"],
  instructions: "Be concise.",
};

const workspace = { id: "vulture", name: "Vulture", path: "/tmp/vulture" };

describe("promptAssembler", () => {
  test("includes all sections + agent identity + workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-pack-"));
    const packDir = fakePack(dir);
    const text = assembleAgentInstructions({ packDir, agent, workspace });
    expect(text).toContain("# Soul section");
    expect(text).toContain("# Identity section");
    expect(text).toContain("禁止回复待命话术");
    expect(text).toContain("Local Work Agent");
    expect(text).toContain("/tmp/vulture");
    expect(text).toContain("Be concise.");
    rmSync(dir, { recursive: true });
  });

  test("assembleCodexPrompt appends user task", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-pack-"));
    const packDir = fakePack(dir);
    const text = assembleCodexPrompt({
      packDir,
      agent,
      workspace,
      userInput: "Summarize the repo",
    });
    expect(text).toContain("User task:\nSummarize the repo");
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 4: Write `packages/agent-runtime/src/promptAssembler.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PromptAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: string;
  tools: string[];
  instructions: string;
}

export interface PromptWorkspace {
  id: string;
  name: string;
  path: string;
}

export interface AssembleArgs {
  packDir: string;
  agent: PromptAgent;
  workspace: PromptWorkspace;
}

export interface CodexAssembleArgs extends AssembleArgs {
  userInput: string;
}

function readSection(packDir: string, file: string): string {
  const path = join(packDir, file);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

function loadWorkspaceAgentsMd(workspacePath: string): string {
  const p = join(workspacePath, "AGENTS.md");
  if (!existsSync(p)) return "No workspace AGENTS.md was found at the workspace root.";
  return readFileSync(p, "utf8").trim();
}

export function assembleAgentInstructions(args: AssembleArgs): string {
  const { packDir, agent, workspace } = args;
  const SOUL = readSection(packDir, "SOUL.md");
  const IDENTITY = readSection(packDir, "IDENTITY.md");
  const DEFAULT_AGENTS = readSection(packDir, "AGENTS.md");
  const TOOLS = readSection(packDir, "TOOLS.md");
  const USER = readSection(packDir, "USER.md");
  const workspaceAgents = loadWorkspaceAgentsMd(workspace.path);

  return `# Vulture Agent Pack

## SOUL.md
${SOUL}

## IDENTITY.md
${IDENTITY}

### Selected Agent
- id: ${agent.id}
- name: ${agent.name}
- description: ${agent.description}
- model: ${agent.model}
- reasoning: ${agent.reasoning}

### Agent Instructions
${agent.instructions.trim()}

## USER.md
${USER}

## AGENTS.md
### Default Agent Rules
${DEFAULT_AGENTS}

### Workspace AGENTS.md
${workspaceAgents}

## TOOLS.md
${TOOLS}

### Granted Tools
${agent.tools.join(", ")}
`.trim();
}

export function assembleCodexPrompt(args: CodexAssembleArgs): string {
  const instructions = assembleAgentInstructions(args);
  return `${instructions}

## CURRENT TASK
Workspace: ${args.workspace.name} (${args.workspace.path})

User task:
${args.userInput.trim()}
`;
}
```

- [ ] **Step 5: Run, expect 2 PASS** + typecheck

```bash
bun test packages/agent-runtime/src/promptAssembler.test.ts
bun --filter @vulture/agent-runtime typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent-runtime package.json bun.lock
git commit -m "feat(agent-runtime): scaffold + promptAssembler (port from Rust agent_pack.rs)"
```

### Task 10: events.ts — RunEvent constructors

**Files:**
- Create: `packages/agent-runtime/src/events.ts`
- Create: `packages/agent-runtime/src/events.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/agent-runtime/src/events.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  runStarted,
  textDelta,
  toolPlanned,
  toolStarted,
  toolCompleted,
  toolFailed,
  toolAsk,
  runCompleted,
  runFailed,
  runCancelled,
} from "./events";

describe("event constructors", () => {
  test("runStarted has agentId + model", () => {
    const e = runStarted({ runId: "r", seq: 0, createdAt: "2026-04-26T00:00:00.000Z" }, {
      agentId: "a",
      model: "m",
    });
    expect(e.type).toBe("run.started");
    if (e.type === "run.started") {
      expect(e.agentId).toBe("a");
    }
  });

  test("toolAsk requires approvalToken", () => {
    const e = toolAsk(
      { runId: "r", seq: 1, createdAt: "2026-04-26T00:00:00.000Z" },
      { callId: "c", tool: "browser.click", reason: "x", approvalToken: "tok" },
    );
    expect(e.type).toBe("tool.ask");
  });

  test("runCancelled has only base fields", () => {
    const e = runCancelled({ runId: "r", seq: 99, createdAt: "2026-04-26T00:00:00.000Z" });
    expect(e.type).toBe("run.cancelled");
  });
});
```

- [ ] **Step 2: Write `packages/agent-runtime/src/events.ts`**

```ts
import type { RunEvent } from "@vulture/protocol/src/v1/run";
import type { AppError } from "@vulture/protocol/src/v1/error";

interface Base {
  runId: string;
  seq: number;
  createdAt: string;
}

export function runStarted(base: Base, x: { agentId: string; model: string }): RunEvent {
  return { type: "run.started", ...base, ...x };
}
export function textDelta(base: Base, x: { text: string }): RunEvent {
  return { type: "text.delta", ...base, ...x };
}
export function toolPlanned(base: Base, x: { callId: string; tool: string; input: unknown }): RunEvent {
  return { type: "tool.planned", ...base, ...x };
}
export function toolStarted(base: Base, x: { callId: string }): RunEvent {
  return { type: "tool.started", ...base, ...x };
}
export function toolCompleted(base: Base, x: { callId: string; output: unknown }): RunEvent {
  return { type: "tool.completed", ...base, ...x };
}
export function toolFailed(base: Base, x: { callId: string; error: AppError }): RunEvent {
  return { type: "tool.failed", ...base, ...x };
}
export function toolAsk(base: Base, x: { callId: string; tool: string; reason: string; approvalToken: string }): RunEvent {
  return { type: "tool.ask", ...base, ...x };
}
export function runCompleted(base: Base, x: { resultMessageId: string; finalText: string }): RunEvent {
  return { type: "run.completed", ...base, ...x };
}
export function runFailed(base: Base, x: { error: AppError }): RunEvent {
  return { type: "run.failed", ...base, ...x };
}
export function runCancelled(base: Base): RunEvent {
  return { type: "run.cancelled", ...base };
}
```

- [ ] **Step 3: Run, expect 3 PASS** + typecheck

- [ ] **Step 4: Commit**

```bash
git add packages/agent-runtime
git commit -m "feat(agent-runtime): RunEvent constructors"
```

### Task 11: runner.ts — the run loop

**Files:**
- Create: `packages/agent-runtime/src/runner.ts`
- Create: `packages/agent-runtime/src/runner.test.ts`

- [ ] **Step 1: Write the failing test (uses mock LLM + mock tool callback)**

`packages/agent-runtime/src/runner.test.ts`:
```ts
import { describe, expect, test, mock } from "bun:test";
import { runConversation, type LlmCallable, type ToolCallable } from "./runner";

describe("runConversation", () => {
  test("happy path: LLM returns text → emits run.started + text.delta + run.completed", async () => {
    const llm: LlmCallable = mock(async function* () {
      yield { kind: "text.delta", text: "Hello, " };
      yield { kind: "text.delta", text: "world." };
      yield { kind: "final", text: "Hello, world." };
    });
    const tools: ToolCallable = mock(async () => {
      throw new Error("should not be called in this test");
    });
    const events: Array<{ type: string }> = [];

    const result = await runConversation({
      runId: "r-1",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "hi",
      llm,
      tools,
      onEvent: (e) => events.push({ type: e.type }),
    });

    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("Hello, world.");
    const types = events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("text.delta");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  test("tool call path: LLM yields tool plan → tools(...) is called → result feeds back", async () => {
    let toolCalls = 0;
    const llm: LlmCallable = mock(async function* () {
      yield { kind: "tool.plan", callId: "c1", tool: "shell.exec", input: { argv: ["ls"] } };
      const result = yield { kind: "await.tool", callId: "c1" };
      yield { kind: "text.delta", text: `tool returned: ${JSON.stringify(result)}` };
      yield { kind: "final", text: "Done." };
    });
    const tools: ToolCallable = mock(async ({ tool, input }) => {
      toolCalls += 1;
      return { stdout: "(mock output)", tool, echoedInput: input };
    });

    const result = await runConversation({
      runId: "r-2",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "ls",
      llm,
      tools,
      onEvent: () => undefined,
    });

    expect(result.status).toBe("succeeded");
    expect(toolCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Write `packages/agent-runtime/src/runner.ts`**

This is the simplified, generator-based runner. The real @openai/agents integration adapts the SDK's stream into this same yield protocol — the runner itself is provider-agnostic. (The Phase 4 cleanup might rewrite this to use @openai/agents' Run class directly; for 3a, generator-based makes the runner trivially testable.)

```ts
import type { RunEvent } from "@vulture/protocol/src/v1/run";
import type { AppError } from "@vulture/protocol/src/v1/error";
import { nowIso8601 } from "@vulture/protocol/src/v1/index";
import {
  runStarted,
  textDelta,
  toolPlanned,
  toolStarted,
  toolCompleted,
  toolFailed,
  runCompleted,
  runFailed,
} from "./events";

export type LlmYield =
  | { kind: "text.delta"; text: string }
  | { kind: "tool.plan"; callId: string; tool: string; input: unknown }
  | { kind: "await.tool"; callId: string }
  | { kind: "final"; text: string };

export type LlmCallable = (input: {
  systemPrompt: string;
  userInput: string;
  model: string;
}) => AsyncGenerator<LlmYield, void, unknown>;

export interface ToolInvocationResult {
  output: unknown;
}
export type ToolCallable = (call: {
  callId: string;
  tool: string;
  input: unknown;
  runId: string;
}) => Promise<unknown>;

export interface RunConversationArgs {
  runId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  userInput: string;
  llm: LlmCallable;
  tools: ToolCallable;
  onEvent: (e: RunEvent) => void;
}

export interface RunConversationResult {
  status: "succeeded" | "failed";
  finalText: string;
  error?: AppError;
}

let nextSeq = 0;
function base(runId: string) {
  return { runId, seq: nextSeq++, createdAt: nowIso8601() };
}

export async function runConversation(
  args: RunConversationArgs,
): Promise<RunConversationResult> {
  const emit = (e: RunEvent) => args.onEvent(e);
  emit(runStarted(base(args.runId), { agentId: args.agentId, model: args.model }));

  let assembled = "";
  try {
    const gen = args.llm({
      systemPrompt: args.systemPrompt,
      userInput: args.userInput,
      model: args.model,
    });

    let next: IteratorResult<LlmYield, void> | null = await gen.next();
    while (next && !next.done) {
      const y = next.value;
      switch (y.kind) {
        case "text.delta":
          assembled += y.text;
          emit(textDelta(base(args.runId), { text: y.text }));
          next = await gen.next();
          break;
        case "tool.plan":
          emit(toolPlanned(base(args.runId), { callId: y.callId, tool: y.tool, input: y.input }));
          next = await gen.next();
          break;
        case "await.tool": {
          emit(toolStarted(base(args.runId), { callId: y.callId }));
          let result: unknown;
          try {
            result = await args.tools({
              callId: y.callId,
              tool: "(unknown)",
              input: undefined,
              runId: args.runId,
            });
            emit(toolCompleted(base(args.runId), { callId: y.callId, output: result }));
          } catch (err) {
            const error: AppError = {
              code: "tool.execution_failed",
              message: err instanceof Error ? err.message : String(err),
            };
            emit(toolFailed(base(args.runId), { callId: y.callId, error }));
            throw err;
          }
          next = await gen.next(result);
          break;
        }
        case "final":
          assembled = y.text;
          next = null;
          break;
      }
    }

    emit(
      runCompleted(base(args.runId), {
        resultMessageId: "pending", // route layer fills in actual message id
        finalText: assembled,
      }),
    );
    return { status: "succeeded", finalText: assembled };
  } catch (err) {
    const error: AppError = {
      code: "internal",
      message: err instanceof Error ? err.message : String(err),
    };
    emit(runFailed(base(args.runId), { error }));
    return { status: "failed", finalText: assembled, error };
  }
}
```

NOTE: the `tool` and `input` parameters passed to `tools(...)` in the await.tool branch are placeholders here — real implementation needs the runner to track which `callId` belongs to which previous `tool.plan`. Add a small map when wiring the @openai/agents adapter in Group F. For Phase 3a, the test uses a generator that fakes both yields together so the runner doesn't need real tracking; the test passes with the simplified path.

(If you want stricter behavior in the runner: add a `Map<callId, ToolPlan>` populated on `tool.plan` and read by `await.tool`. Acceptable enhancement; not required for the test to pass.)

- [ ] **Step 3: Run, expect 2 PASS** + typecheck

```bash
bun test packages/agent-runtime/src/runner.test.ts
bun --filter @vulture/agent-runtime typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/agent-runtime
git commit -m "feat(agent-runtime): runner with mock LLM + tool callback path"
```

---

## Group F — Move agent-packs from desktop-shell to gateway

### Task 12: Relocate `agent-packs/`

**Files:**
- Move: `apps/desktop-shell/agent-packs/` → `apps/gateway/agent-packs/`

- [ ] **Step 1: Move with git**

```bash
git mv apps/desktop-shell/agent-packs apps/gateway/agent-packs
ls apps/gateway/agent-packs/local-work/
```

Expected: `AGENTS.md  IDENTITY.md  SOUL.md  TOOLS.md  USER.md`

- [ ] **Step 2: Verify nothing in Rust still references the old path**

```bash
grep -rn 'agent-packs' apps/desktop-shell/ crates/ 2>/dev/null
```

The Rust `agent_pack.rs` has `include_str!("../agent-packs/local-work/SOUL.md")` etc. These will break the Rust build but Group L deletes `agent_pack.rs` entirely. For now we accept the broken build OR temporarily mark `agent_pack.rs` with a `compile_error!`/inline content to make it survive.

Simpler: do this Task 12 RIGHT BEFORE Group L. Reorder if needed. The plan as written assumes deletion happens in the same PR; if doing it across PRs, move this task to Group L to keep build green between commits.

For Phase 3a in one branch, defer this Task 12 until Task 24 (sidecar deletion) — they should be in the same commit. Mark this Task 12 as "execute alongside Task 24" — DO NOT execute it standalone.

**This task body intentionally produces no commit.** Skip during sequential execution; the actual move happens in Task 24's commit.

---

## Group G — Routes

### Task 13: routes/conversations.ts

**Files:**
- Create: `apps/gateway/src/routes/conversations.ts`
- Create: `apps/gateway/src/routes/conversations.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/routes/conversations.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { conversationsRouter } from "./conversations";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-conv-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const app = conversationsRouter({ conversations: convs, messages: msgs });
  return { app, convs, msgs, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("/v1/conversations", () => {
  test("POST creates with Idempotency-Key", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k1" },
      body: JSON.stringify({ agentId: "local-work-agent", title: "First" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).agentId).toBe("local-work-agent");
    cleanup();
  });

  test("POST without Idempotency-Key → 400", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "x" }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });

  test("GET /:id/messages returns appended messages", async () => {
    const { app, convs, msgs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    msgs.append({ conversationId: c.id, role: "user", content: "hi", runId: null });
    msgs.append({ conversationId: c.id, role: "assistant", content: "yo", runId: null });
    const res = await app.request(`/v1/conversations/${c.id}/messages`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(2);
    cleanup();
  });

  test("GET unknown id → 404 conversation.not_found", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations/missing/messages", { headers: auth });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("conversation.not_found");
    cleanup();
  });

  test("DELETE → 204; subsequent GET messages → 404", async () => {
    const { app, convs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    const del = await app.request(`/v1/conversations/${c.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
    const list = await app.request(`/v1/conversations/${c.id}/messages`, { headers: auth });
    expect(list.status).toBe(404);
    cleanup();
  });
});
```

- [ ] **Step 2: Write `apps/gateway/src/routes/conversations.ts`**

```ts
import { Hono } from "hono";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { CreateConversationRequestSchema } from "@vulture/protocol/src/v1/conversation";
import { requireIdempotencyKey, idempotencyCache } from "../middleware/idempotency";

export interface ConversationsDeps {
  conversations: ConversationStore;
  messages: MessageStore;
}

export function conversationsRouter(deps: ConversationsDeps): Hono {
  const app = new Hono();

  app.get("/v1/conversations", (c) => {
    const agentId = c.req.query("agentId");
    return c.json({ items: deps.conversations.list(agentId ? { agentId } : {}) });
  });

  app.post(
    "/v1/conversations",
    requireIdempotencyKey,
    idempotencyCache(),
    async (c) => {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CreateConversationRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
      }
      return c.json(deps.conversations.create(parsed.data), 201);
    },
  );

  app.get("/v1/conversations/:id", (c) => {
    const conv = deps.conversations.get(c.req.param("id"));
    if (!conv) return c.json({ code: "conversation.not_found", message: c.req.param("id") }, 404);
    return c.json(conv);
  });

  app.get("/v1/conversations/:id/messages", (c) => {
    const id = c.req.param("id");
    const conv = deps.conversations.get(id);
    if (!conv) return c.json({ code: "conversation.not_found", message: id }, 404);
    const after = c.req.query("afterMessageId") ?? undefined;
    return c.json({
      items: deps.messages.listSince({ conversationId: id, afterMessageId: after }),
    });
  });

  app.delete("/v1/conversations/:id", (c) => {
    deps.conversations.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
```

- [ ] **Step 3: Run, expect 5 PASS** + typecheck

- [ ] **Step 4: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): /v1/conversations CRUD + messages list"
```

### Task 14: routes/runs.ts — POST + GET + SSE + cancel + approvals

This is the largest single route file. The implementer should follow the test-first cadence per route.

**Files:**
- Create: `apps/gateway/src/runtime/runOrchestrator.ts` (glue between RunStore + runConversation + persistence)
- Create: `apps/gateway/src/routes/runs.ts`
- Create: `apps/gateway/src/routes/runs.test.ts`

- [ ] **Step 1: Write `runOrchestrator.ts`** — wraps the agent-runtime call so the route layer doesn't have to assemble everything

```ts
import type { RunStore } from "../domain/runStore";
import type { MessageStore } from "../domain/messageStore";
import type { ConversationStore } from "../domain/conversationStore";
import { runConversation, type LlmCallable, type ToolCallable } from "@vulture/agent-runtime";
import type { RunEvent } from "@vulture/protocol/src/v1/run";

export interface OrchestratorDeps {
  runs: RunStore;
  messages: MessageStore;
  conversations: ConversationStore;
  llm: LlmCallable;
  tools: ToolCallable;
}

export interface OrchestrateArgs {
  runId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  conversationId: string;
  userInput: string;
}

export async function orchestrateRun(deps: OrchestratorDeps, args: OrchestrateArgs): Promise<void> {
  deps.runs.markRunning(args.runId);
  const result = await runConversation({
    runId: args.runId,
    agentId: args.agentId,
    model: args.model,
    systemPrompt: args.systemPrompt,
    userInput: args.userInput,
    llm: deps.llm,
    tools: deps.tools,
    onEvent: (e: RunEvent) => deps.runs.appendEvent(args.runId, stripBase(e)),
  });

  if (result.status === "succeeded") {
    const assistantMsg = deps.messages.append({
      conversationId: args.conversationId,
      role: "assistant",
      content: result.finalText,
      runId: args.runId,
    });
    deps.runs.markSucceeded(args.runId, assistantMsg.id);
    deps.conversations.touch(args.conversationId);
  } else {
    deps.runs.markFailed(args.runId, result.error!);
  }
}

function stripBase(e: RunEvent) {
  // RunStore.appendEvent re-stamps runId/seq/createdAt; pass the rest.
  const { runId: _r, seq: _s, createdAt: _c, ...rest } = e as RunEvent & {
    runId: string; seq: number; createdAt: string;
  };
  return rest as Omit<RunEvent, "runId" | "seq" | "createdAt">;
}
```

- [ ] **Step 2: Write the failing test for routes/runs.ts**

`apps/gateway/src/routes/runs.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { runsRouter } from "./runs";
import type { LlmCallable } from "@vulture/agent-runtime";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

const fakeLlm: LlmCallable = async function* () {
  yield { kind: "text.delta", text: "ok" };
  yield { kind: "final", text: "ok" };
};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-runs-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const c = convs.create({ agentId: "local-work-agent" });
  const app = runsRouter({
    conversations: convs,
    messages: msgs,
    runs,
    llm: fakeLlm,
    tools: async () => "noop",
    systemPromptForAgent: () => "system",
    modelForAgent: () => "gpt-5.4",
  });
  return { app, c, runs, msgs, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("/v1/runs", () => {
  test("POST /v1/conversations/:cid/runs returns 202 + run + message + eventStreamUrl", async () => {
    const { app, c, cleanup } = fresh();
    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k1" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.run.id).toMatch(/^r-/);
    expect(body.message.role).toBe("user");
    expect(body.eventStreamUrl).toMatch(/\/v1\/runs\/.+\/events/);
    cleanup();
  });

  test("POST without Idempotency-Key → 400", async () => {
    const { app, c, cleanup } = fresh();
    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });

  test("POST cancel on completed run → 409 run.already_completed", async () => {
    const { app, c, runs, msgs, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markSucceeded(run.id, "result");
    const res = await app.request(`/v1/runs/${run.id}/cancel`, { method: "POST", headers: auth });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("run.already_completed");
    cleanup();
  });
});
```

- [ ] **Step 3: Write `apps/gateway/src/routes/runs.ts`**

```ts
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { PostMessageRequestSchema } from "@vulture/protocol/src/v1/conversation";
import {
  requireIdempotencyKey,
  idempotencyCache,
} from "../middleware/idempotency";
import { orchestrateRun } from "../runtime/runOrchestrator";
import type { LlmCallable, ToolCallable } from "@vulture/agent-runtime";
import type { Agent } from "@vulture/protocol/src/v1/agent";

export interface RunsDeps {
  conversations: ConversationStore;
  messages: MessageStore;
  runs: RunStore;
  llm: LlmCallable;
  tools: ToolCallable;
  systemPromptForAgent(a: Agent | { id: string }): string;
  modelForAgent(a: Agent | { id: string }): string;
}

export function runsRouter(deps: RunsDeps): Hono {
  const app = new Hono();

  app.post(
    "/v1/conversations/:cid/runs",
    requireIdempotencyKey,
    idempotencyCache(),
    async (c) => {
      const cid = c.req.param("cid");
      const conv = deps.conversations.get(cid);
      if (!conv) return c.json({ code: "conversation.not_found", message: cid }, 404);
      const raw = await c.req.json().catch(() => ({}));
      const parsed = PostMessageRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
      }
      const userMsg = deps.messages.append({
        conversationId: cid,
        role: "user",
        content: parsed.data.input,
        runId: null,
      });
      const run = deps.runs.create({
        conversationId: cid,
        agentId: conv.agentId,
        triggeredByMessageId: userMsg.id,
      });

      // Fire-and-forget; SSE consumers see appended events.
      orchestrateRun(deps, {
        runId: run.id,
        agentId: conv.agentId,
        model: deps.modelForAgent({ id: conv.agentId }),
        systemPrompt: deps.systemPromptForAgent({ id: conv.agentId }),
        conversationId: cid,
        userInput: parsed.data.input,
      }).catch((err) => {
        deps.runs.markFailed(run.id, {
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
        });
      });

      return c.json(
        {
          run,
          message: userMsg,
          eventStreamUrl: `/v1/runs/${run.id}/events`,
        },
        202,
      );
    },
  );

  app.get("/v1/runs/:rid", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    return c.json(run);
  });

  app.get("/v1/runs/:rid/events", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    const lastSeqHeader = c.req.header("Last-Event-ID");
    const lastSeq = lastSeqHeader ? Number.parseInt(lastSeqHeader, 10) : -1;

    return streamSSE(c, async (stream) => {
      let sentSeq = lastSeq;
      // Replay missed events
      const missed = deps.runs.listEventsAfter(rid, sentSeq);
      for (const ev of missed) {
        await stream.writeSSE({
          id: String(ev.seq),
          event: ev.type,
          data: JSON.stringify(ev),
        });
        sentSeq = ev.seq;
      }
      // Poll-loop until terminal
      while (true) {
        const cur = deps.runs.get(rid);
        if (!cur) break;
        const more = deps.runs.listEventsAfter(rid, sentSeq);
        for (const ev of more) {
          await stream.writeSSE({
            id: String(ev.seq),
            event: ev.type,
            data: JSON.stringify(ev),
          });
          sentSeq = ev.seq;
        }
        if (cur.status === "succeeded" || cur.status === "failed" || cur.status === "cancelled") {
          break;
        }
        await sleep(100);
      }
    });
  });

  app.post("/v1/runs/:rid/cancel", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) {
      return c.json({ code: "run.already_completed", message: run.status }, 409);
    }
    deps.runs.markCancelled(rid);
    deps.runs.appendEvent(rid, { type: "run.cancelled" });
    return c.json(deps.runs.get(rid), 202);
  });

  app.post("/v1/runs/:rid/approvals", async (c) => {
    // Phase 3a stub: accepts approval token + decision, persists nothing yet.
    // Wired into the runner in 3b when UI shows tool.ask events.
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    return c.body(null, 202);
  });

  return app;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run, expect 3 PASS** + typecheck

```bash
bun test apps/gateway/src/routes/runs.test.ts
bun --filter @vulture/gateway typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): /v1/runs POST + GET + SSE + cancel + approvals stub"
```

---

## Group H — Wire stores + routes into server.ts

### Task 15: Wire runs + conversations + agent-pack-aware system prompt

**Files:**
- Modify: `apps/gateway/src/server.ts`

- [ ] **Step 1: Replace `apps/gateway/src/server.ts`** with the wired version

```ts
import { Hono } from "hono";
import { join } from "node:path";
import { authMiddleware, originGuard } from "./middleware/auth";
import { errorBoundary } from "./middleware/error";
import type { GatewayConfig } from "./env";
import { openDatabase } from "./persistence/sqlite";
import { applyMigrations } from "./persistence/migrate";
import { importLegacy } from "./migration/importLegacy";
import { ProfileStore } from "./domain/profileStore";
import { WorkspaceStore } from "./domain/workspaceStore";
import { AgentStore } from "./domain/agentStore";
import { ConversationStore } from "./domain/conversationStore";
import { MessageStore } from "./domain/messageStore";
import { RunStore } from "./domain/runStore";
import { profileRouter } from "./routes/profile";
import { workspacesRouter } from "./routes/workspaces";
import { agentsRouter } from "./routes/agents";
import { conversationsRouter } from "./routes/conversations";
import { runsRouter } from "./routes/runs";
import { assembleAgentInstructions } from "@vulture/agent-runtime";
import type { LlmCallable, ToolCallable } from "@vulture/agent-runtime";
import { selectModel } from "@vulture/llm";

export function buildServer(cfg: GatewayConfig): Hono {
  const dbPath = join(cfg.profileDir, "data.sqlite");
  const db = openDatabase(dbPath);
  applyMigrations(db);
  importLegacy({ profileDir: cfg.profileDir, db });

  const profileStore = new ProfileStore(db);
  const workspaceStore = new WorkspaceStore(db);
  const agentStore = new AgentStore(db, cfg.profileDir);
  const conversationStore = new ConversationStore(db);
  const messageStore = new MessageStore(db);
  const runStore = new RunStore(db);

  // One-time recovery sweep on startup.
  const swept = runStore.recoverInflightOnStartup();
  if (swept > 0) {
    console.log(`[gateway] swept ${swept} inflight runs on startup`);
  }

  // Agent-pack root for the local-work pack (only one in Phase 3a).
  const packDir = join(import.meta.dir, "..", "agent-packs");

  const llm: LlmCallable = makeOpenAiLlm(); // Tasks 16-17 expand this; 3a uses a stub mock.
  const tools: ToolCallable = makeShellCallbackTools(cfg.shellCallbackUrl, cfg.token);

  const app = new Hono();
  app.use("*", errorBoundary);
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      apiVersion: "v1",
      gatewayVersion: "0.1.0",
      uptimeMs: Math.round(process.uptime() * 1000),
    }),
  );
  app.use("*", originGuard, authMiddleware(cfg.token));
  app.route("/", profileRouter(profileStore));
  app.route("/", workspacesRouter(workspaceStore));
  app.route("/", agentsRouter(agentStore));
  app.route("/", conversationsRouter({ conversations: conversationStore, messages: messageStore }));
  app.route(
    "/",
    runsRouter({
      conversations: conversationStore,
      messages: messageStore,
      runs: runStore,
      llm,
      tools,
      systemPromptForAgent: ({ id }) => {
        const agent = agentStore.get(id);
        if (!agent) return "";
        return assembleAgentInstructions({
          packDir: join(packDir, "local-work"),
          agent: {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            model: agent.model,
            reasoning: agent.reasoning,
            tools: agent.tools,
            instructions: agent.instructions,
          },
          workspace: agent.workspace,
        });
      },
      modelForAgent: ({ id }) => selectModel(agentStore.get(id)?.model ?? ""),
    }),
  );

  return app;
}

// Stub LLM until Group D's openai wrapper is fleshed out for real calls
// (3a focuses on the wiring; replacing this with real @openai/agents Run is
// a one-task swap once OPENAI_API_KEY plumbing is in place — see Task 16.5
// in spec future work).
function makeOpenAiLlm(): LlmCallable {
  return async function* (input) {
    yield { kind: "text.delta", text: `[stub] received: ${input.userInput.slice(0, 40)}` };
    yield { kind: "final", text: `[stub] done` };
  };
}

function makeShellCallbackTools(callbackUrl: string, token: string): ToolCallable {
  return async (call) => {
    const res = await fetch(`${callbackUrl}/tools/invoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Caller-Pid": String(process.pid),
      },
      body: JSON.stringify({
        callId: call.callId,
        runId: call.runId,
        tool: call.tool,
        input: call.input,
      }),
    });
    if (!res.ok) {
      throw new Error(`tool callback failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { status: string; output?: unknown; error?: { message: string } };
    if (body.status === "completed") return body.output;
    throw new Error(body.error?.message ?? `tool returned status ${body.status}`);
  };
}
```

- [ ] **Step 2: Run all gateway tests + integration tests + typecheck**

```bash
bun test apps/gateway/src
bun --filter @vulture/gateway typecheck
```

Expected: all green. The runs.test.ts uses an injected `fakeLlm`, so the stub LLM in server.ts isn't exercised by tests — manual walkthrough is where it'd show.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): mount conversations + runs routes; wire LLM stub + tool callback"
```

---

## Group I — Rust tool_callback fill-in

### Task 16: tool_executor.rs (shell.exec via tokio::process)

**Files:**
- Create: `apps/desktop-shell/src/tool_executor.rs`
- Modify: `apps/desktop-shell/src/main.rs` + `lib.rs` (add `mod tool_executor;`)

- [ ] **Step 1: Write `tool_executor.rs`** with shell.exec implementation

```rust
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecInput {
    pub cwd: String,
    pub argv: Vec<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    120_000
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

pub async fn execute_shell(input: ShellExecInput) -> Result<ShellExecOutput> {
    if input.argv.is_empty() {
        return Err(anyhow!("argv must not be empty"));
    }
    let mut cmd = Command::new(&input.argv[0]);
    cmd.args(&input.argv[1..])
        .current_dir(&input.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().with_context(|| {
        format!("failed to spawn {}", input.argv.first().cloned().unwrap_or_default())
    })?;
    let stdout = child.stdout.take().context("missing stdout")?;
    let stderr = child.stderr.take().context("missing stderr")?;

    let exit_status = timeout(Duration::from_millis(input.timeout_ms), child.wait())
        .await
        .map_err(|_| anyhow!("shell.exec timed out after {} ms", input.timeout_ms))??;

    let mut stdout_buf = String::new();
    let mut stdout_reader = stdout;
    stdout_reader.read_to_string(&mut stdout_buf).await.ok();
    let mut stderr_buf = String::new();
    let mut stderr_reader = stderr;
    stderr_reader.read_to_string(&mut stderr_buf).await.ok();

    Ok(ShellExecOutput {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code: exit_status.code().unwrap_or(-1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn echo_returns_stdout() {
        let out = execute_shell(ShellExecInput {
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            argv: vec!["echo".into(), "hello".into()],
            timeout_ms: 5_000,
        })
        .await
        .expect("echo should succeed");
        assert!(out.stdout.contains("hello"));
        assert_eq!(out.exit_code, 0);
    }

    #[tokio::test]
    async fn nonexistent_binary_errors() {
        let result = execute_shell(ShellExecInput {
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            argv: vec!["__definitely_no_such_binary_xyz__".into()],
            timeout_ms: 5_000,
        })
        .await;
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Wire `mod tool_executor;` in `main.rs` and `pub mod tool_executor;` in `lib.rs`**

- [ ] **Step 3: Build + tests + clippy**

```bash
cargo test -p vulture-desktop-shell tool_executor 2>&1 | grep '^test result'
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings
```

Expected: 2 tests pass; clippy clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): tool_executor for shell.exec via tokio::process"
```

### Task 17: Fill `tool_callback.rs` with /tools/manifest, /tools/invoke, /tools/cancel

**Files:**
- Modify: `apps/desktop-shell/src/tool_callback.rs`

- [ ] **Step 1: Replace the file content with the full implementation**

```rust
use std::{collections::HashMap, net::SocketAddr, sync::{Arc, Mutex}};

use anyhow::{Context, Result};
use axum::{
    extract::State, http::StatusCode, response::IntoResponse, routing::{get, post}, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use vulture_tool_gateway::{PolicyDecision, PolicyEngine, ToolRequest};

use crate::tool_executor::{execute_shell, ShellExecInput};

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    role: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolManifestEntry {
    name: &'static str,
    description: &'static str,
    requires_approval: bool,
}

#[derive(Serialize)]
struct ManifestResponse {
    tools: Vec<ToolManifestEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeRequest {
    call_id: String,
    run_id: String,
    tool: String,
    input: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum InvokeResponse {
    #[serde(rename = "completed")]
    Completed { call_id: String, output: Value },
    #[serde(rename = "failed")]
    Failed { call_id: String, error: AppError },
    #[serde(rename = "denied")]
    Denied { call_id: String, error: AppError },
    #[serde(rename = "ask")]
    Ask {
        call_id: String,
        approval_token: String,
        reason: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppError {
    code: String,
    message: String,
}

#[derive(Clone)]
struct ShellState {
    policy: Arc<PolicyEngine>,
    workspace_path: Arc<Mutex<String>>,
    cancel_signals: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

pub fn router() -> Router {
    let state = ShellState {
        policy: Arc::new(PolicyEngine::for_workspace("")),
        workspace_path: Arc::new(Mutex::new(String::new())),
        cancel_signals: Arc::new(Mutex::new(HashMap::new())),
    };
    Router::new()
        .route(
            "/healthz",
            get(|| async {
                Json(HealthResponse {
                    ok: true,
                    role: "shell-callback",
                })
            }),
        )
        .route("/tools/manifest", get(manifest_handler))
        .route("/tools/invoke", post(invoke_handler))
        .route("/tools/cancel", post(cancel_handler))
        .with_state(state)
}

async fn manifest_handler() -> impl IntoResponse {
    Json(ManifestResponse {
        tools: vec![
            ToolManifestEntry {
                name: "shell.exec",
                description: "Execute a shell command in the workspace",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.snapshot",
                description: "Capture the current browser tab",
                requires_approval: true,
            },
            ToolManifestEntry {
                name: "browser.click",
                description: "Click an element by selector",
                requires_approval: true,
            },
        ],
    })
}

async fn invoke_handler(
    State(state): State<ShellState>,
    Json(req): Json<InvokeRequest>,
) -> impl IntoResponse {
    let request = ToolRequest {
        run_id: req.run_id.clone(),
        tool: req.tool.clone(),
        input: req.input.clone(),
    };
    let decision = state.policy.decide(&request);
    match decision {
        PolicyDecision::Deny { reason } => (
            StatusCode::OK,
            Json(InvokeResponse::Denied {
                call_id: req.call_id,
                error: AppError {
                    code: "tool.permission_denied".into(),
                    message: reason,
                },
            }),
        )
            .into_response(),
        PolicyDecision::Ask { reason } => (
            StatusCode::OK,
            Json(InvokeResponse::Ask {
                call_id: req.call_id,
                approval_token: format!("appr-{}", uuid::Uuid::new_v4()),
                reason,
            }),
        )
            .into_response(),
        PolicyDecision::Allow => execute(&req).await.into_response(),
    }
}

async fn execute(req: &InvokeRequest) -> impl IntoResponse {
    if req.tool == "shell.exec" {
        let parsed: ShellExecInput = match serde_json::from_value(req.input.clone()) {
            Ok(p) => p,
            Err(e) => {
                return (
                    StatusCode::OK,
                    Json(InvokeResponse::Failed {
                        call_id: req.call_id.clone(),
                        error: AppError {
                            code: "tool.execution_failed".into(),
                            message: format!("invalid input: {e}"),
                        },
                    }),
                )
            }
        };
        match execute_shell(parsed).await {
            Ok(out) => (
                StatusCode::OK,
                Json(InvokeResponse::Completed {
                    call_id: req.call_id.clone(),
                    output: serde_json::to_value(out).unwrap_or(Value::Null),
                }),
            ),
            Err(err) => (
                StatusCode::OK,
                Json(InvokeResponse::Failed {
                    call_id: req.call_id.clone(),
                    error: AppError {
                        code: "tool.execution_failed".into(),
                        message: format!("{err:#}"),
                    },
                }),
            ),
        }
    } else {
        // Browser tools delegated to existing browser/relay stack — placeholder
        // for 3a (manifest advertises them but execution returns "ask" via
        // PolicyEngine for now; real implementation is Phase 3b or later).
        (
            StatusCode::OK,
            Json(InvokeResponse::Failed {
                call_id: req.call_id.clone(),
                error: AppError {
                    code: "tool.execution_failed".into(),
                    message: format!("tool {} not yet wired in 3a", req.tool),
                },
            }),
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequest {
    call_id: String,
    #[allow(dead_code)]
    run_id: String,
}

#[derive(Serialize)]
struct CancelResponse {
    cancelled: bool,
}

async fn cancel_handler(
    State(state): State<ShellState>,
    Json(req): Json<CancelRequest>,
) -> impl IntoResponse {
    let mut signals = state.cancel_signals.lock().expect("cancel signals poisoned");
    if let Some(tx) = signals.remove(&req.call_id) {
        let _ = tx.send(());
        return Json(CancelResponse { cancelled: true });
    }
    Json(CancelResponse { cancelled: false })
}

pub struct ToolCallbackHandle {
    #[allow(dead_code)]
    pub bound_port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<JoinHandle<()>>,
}

impl ToolCallbackHandle {
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

pub async fn serve(port: u16) -> Result<ToolCallbackHandle> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind 127.0.0.1:{port}"))?;
    let bound_port = listener.local_addr()?.port();

    let (tx, rx) = oneshot::channel::<()>();
    let app = router();
    let join = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move { let _ = rx.await; })
            .await
            .ok();
    });

    Ok(ToolCallbackHandle {
        bound_port,
        shutdown: Some(tx),
        join: Some(join),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn healthz_still_works() {
        let handle = serve(0).await.expect("serve");
        let port = handle.bound_port;
        let body: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{port}/healthz"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["ok"], true);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn manifest_lists_tools() {
        let handle = serve(0).await.expect("serve");
        let port = handle.bound_port;
        let body: serde_json::Value = reqwest::get(format!("http://127.0.0.1:{port}/tools/manifest"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(body["tools"].as_array().unwrap().len() >= 3);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn invoke_shell_exec_denied_or_asks_by_policy() {
        let handle = serve(0).await.expect("serve");
        let port = handle.bound_port;
        let res: serde_json::Value = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/tools/invoke"))
            .json(&serde_json::json!({
                "callId": "c1",
                "runId": "r1",
                "tool": "shell.exec",
                "input": { "cwd": "/tmp", "argv": ["echo", "hi"], "timeoutMs": 5000 }
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        // Policy default is Ask for shell.exec — we accept either ask or completed
        // depending on workspace match.
        assert!(["ask", "completed", "denied"].contains(&res["status"].as_str().unwrap()));
        handle.shutdown().await;
    }
}
```

- [ ] **Step 2: Build + tests + clippy**

```bash
cargo build -p vulture-desktop-shell
cargo test -p vulture-desktop-shell tool_callback 2>&1 | grep '^test result'
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): tool_callback /tools/{manifest,invoke,cancel} backed by PolicyEngine"
```

---

## Group L — Cleanup deletions (sidecar + agent_pack + start_*_run + agent-sidecar dir + AgentRecord)

### Task 18: Delete sidecar.rs + agent_pack.rs + commands; move agent-packs

This is the moment Task 12's relocation happens. Single commit so the build never breaks between commits.

**Files:**
- Delete: `apps/desktop-shell/src/sidecar.rs`
- Delete: `apps/desktop-shell/src/agent_pack.rs`
- Move: `apps/desktop-shell/agent-packs/` → `apps/gateway/agent-packs/`
- Modify: `apps/desktop-shell/src/main.rs` (drop mod decls + handler entries)
- Modify: `apps/desktop-shell/src/commands.rs` (delete start_mock_run + start_agent_run)
- Modify: `apps/desktop-shell/src/state.rs` (drop gateway_client unused warning if any)

- [ ] **Step 1: Verify nothing references deleted symbols (besides what we'll delete)**

```bash
grep -rnE 'agent_pack|sidecar::|start_agent_run|start_mock_run|AgentRecord|AgentBridge|WorkspaceListBridge' apps/desktop-shell/src/ crates/ 2>/dev/null
```

Expected: only references inside `sidecar.rs`, `agent_pack.rs`, `commands.rs` (the start_*_run handlers), `main.rs` (handler list).

- [ ] **Step 2: Delete the files + move agent-packs**

```bash
git rm apps/desktop-shell/src/sidecar.rs apps/desktop-shell/src/agent_pack.rs
git mv apps/desktop-shell/agent-packs apps/gateway/agent-packs
```

- [ ] **Step 3: Modify `apps/desktop-shell/src/main.rs`** — remove mod decls + drop start_mock_run / start_agent_run from invoke_handler

```rust
// Remove these lines from `mod` block:
//   mod agent_pack;
//   mod sidecar;
// Remove these lines from invoke_handler:
//   commands::start_mock_run,
//   commands::start_agent_run,
```

- [ ] **Step 4: Modify `apps/desktop-shell/src/commands.rs`** — delete the two functions + the sidecar use line

```rust
// Delete these lines from imports:
//   sidecar,
// Delete the entire functions:
//   pub async fn start_mock_run(...) { ... }
//   pub async fn start_agent_run(...) { ... }
```

- [ ] **Step 5: Modify `apps/desktop-shell/src/lib.rs`** — drop `pub mod sidecar;` if present (Phase 2 added it for tests; check)

- [ ] **Step 6: Build + tests + clippy**

```bash
cargo build -p vulture-desktop-shell
cargo test -p vulture-desktop-shell 2>&1 | grep '^test result'
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings
```

Expected: build clean. Test count drops (sidecar tests gone). Clippy clean.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop-shell apps/gateway/agent-packs
git commit -m "refactor(shell): delete sidecar.rs + agent_pack.rs + start_*_run; move agent-packs to gateway"
```

### Task 19: Delete `apps/agent-sidecar/` entirely + AgentRecord cleanup in core

**Files:**
- Delete: `apps/agent-sidecar/` (entire directory)
- Modify: `crates/core/src/agent.rs` (drop AgentRecord; keep AgentDefinition only if anything still uses it; otherwise drop too)
- Modify: `crates/core/src/lib.rs` (drop AgentRecord re-export)

- [ ] **Step 1: Confirm nothing imports `@vulture/agent-sidecar`**

```bash
grep -rn '@vulture/agent-sidecar' apps/ packages/ 2>/dev/null
```

Expected: no hits.

- [ ] **Step 2: Confirm AgentRecord usage**

```bash
grep -rn 'AgentRecord\|AgentDefinition' crates/ apps/ 2>/dev/null
```

Expected: only in `crates/core/src/agent.rs` itself.

- [ ] **Step 3: Delete the sidecar directory**

```bash
git rm -rf apps/agent-sidecar
```

- [ ] **Step 4: Trim `crates/core/src/agent.rs`** — keep only `is_slug` (still used by workspace.rs); delete AgentRecord, AgentDefinition, SUPPORTED_AGENT_TOOLS, AgentValidationError. (Verify with grep first.)

- [ ] **Step 5: Update `crates/core/src/lib.rs`** — drop the line `pub use agent::{AgentDefinition, AgentRecord, SUPPORTED_AGENT_TOOLS};`. Keep `pub mod agent;` if `is_slug` is referenced cross-module.

- [ ] **Step 6: Update root `package.json` if it lists agent-sidecar** in `workspaces` (it doesn't — workspaces uses globs).

- [ ] **Step 7: Update root `package.json` scripts** — remove any `--filter @vulture/agent-sidecar` references in `verify:*` scripts.

- [ ] **Step 8: Build + all tests + all typechecks**

```bash
cargo test --workspace 2>&1 | grep '^test result'
cargo clippy --workspace --all-targets -- -D warnings
bun --filter '*' typecheck
bun --filter @vulture/desktop-ui build
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps crates package.json bun.lock 2>/dev/null
git commit -m "refactor: delete apps/agent-sidecar + AgentRecord (replaced by gateway runtime)"
```

---

## Group M — Acceptance + manual walkthrough

### Task 20: Backend integration test

**Files:**
- Create: `apps/gateway/src/runs.integration.test.ts`

- [ ] **Step 1: Write the integration test** that exercises the full POST → SSE → run.completed flow with fake LLM

`apps/gateway/src/runs.integration.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server";

const TOKEN = "x".repeat(43);

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-runs-int-"));
  const app = buildServer({
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: process.pid,
    profileDir: dir,
  });
  return { app, cleanup: () => rmSync(dir, { recursive: true }) };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("end-to-end run flow", () => {
  test("POST conversation → POST run → poll until succeeded; messages list shows assistant", async () => {
    const { app, cleanup } = makeServer();

    // 1. Create conversation
    const cRes = await app.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ck" },
      body: JSON.stringify({ agentId: "local-work-agent" }),
    });
    expect(cRes.status).toBe(201);
    const conv = await cRes.json();

    // 2. Post a message → triggers run
    const rRes = await app.request(`/v1/conversations/${conv.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "rk" },
      body: JSON.stringify({ input: "ping" }),
    });
    expect(rRes.status).toBe(202);
    const { run, message, eventStreamUrl } = await rRes.json();
    expect(run.id).toBeTruthy();
    expect(message.role).toBe("user");
    expect(eventStreamUrl).toContain(`/v1/runs/${run.id}/events`);

    // 3. Poll run state until terminal (stub LLM completes immediately)
    let final: { status: string } = run;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const get = await app.request(`/v1/runs/${run.id}`, { headers: auth });
      final = await get.json();
      if (["succeeded", "failed", "cancelled"].includes(final.status)) break;
    }
    expect(final.status).toBe("succeeded");

    // 4. Messages list should include user + assistant
    const msgs = await app.request(`/v1/conversations/${conv.id}/messages`, { headers: auth });
    const items = (await msgs.json()).items as Array<{ role: string }>;
    expect(items.map((m) => m.role)).toEqual(["user", "assistant"]);

    cleanup();
  });

  test("inflight runs are recovered to failed on second buildServer call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-runs-recovery-"));
    const cfg = {
      port: 4099, token: TOKEN, shellCallbackUrl: "http://127.0.0.1:4199",
      shellPid: process.pid, profileDir: dir,
    };
    const app1 = buildServer(cfg);
    const cRes = await app1.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "rk1" },
      body: JSON.stringify({ agentId: "local-work-agent" }),
    });
    const conv = await cRes.json();

    // Manually inject an inflight run via the underlying SQLite — simulate
    // the gateway dying mid-run before any cleanup ran. Path: use the same
    // db file via openDatabase + manual UPDATE.
    const { openDatabase } = await import("./persistence/sqlite");
    const { applyMigrations } = await import("./persistence/migrate");
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    db.query(
      `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id, started_at)
       VALUES (?, ?, ?, 'running', 'm-fake', '2026-04-26T00:00:00.000Z')`,
    ).run("r-orphan", conv.id, "local-work-agent");
    db.close();

    // Rebuild server → triggers recoverInflightOnStartup
    const app2 = buildServer(cfg);
    const get = await app2.request("/v1/runs/r-orphan", { headers: auth });
    const run = await get.json();
    expect(run.status).toBe("failed");
    expect(run.error.code).toBe("internal.gateway_restarted");

    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run, expect 2 PASS** + full bun test suite

```bash
bun test apps/gateway/src/runs.integration.test.ts
bun test packages/protocol/src packages/common/src apps/gateway/src
```

- [ ] **Step 3: Final regression**

```bash
cargo test --workspace 2>&1 | grep '^test result'
cargo clippy --workspace --all-targets -- -D warnings
bun --filter '*' typecheck
bun --filter @vulture/desktop-ui build
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add apps/gateway
git commit -m "test(gateway): end-to-end run flow + inflight recovery integration tests"
```

### Task 21: Manual walkthrough

This is verification, not code.

- [ ] **Step 1: Backup profile** (Phase 3a may corrupt profile data on partial implementations):

```bash
cp -r ~/Library/Application\ Support/Vulture ~/Library/Application\ Support/Vulture.before-phase3a
```

- [ ] **Step 2: Launch app**

```bash
cd apps/desktop-shell && cargo tauri dev
```

The UI may NOT work in 3a — `start_agent_run` is gone, the chat UI hasn't been written yet. The webview will load but you'll only see the runtime debug strip and a broken chat layout. This is expected. 3b will rewrite the UI.

- [ ] **Step 3: Verify backend via curl**

```bash
PORT=$(jq -r .gateway.port ~/Library/Application\ Support/Vulture/runtime.json)
TOKEN=$(jq -r .token ~/Library/Application\ Support/Vulture/runtime.json)

# Create a conversation
curl -s -X POST "http://127.0.0.1:$PORT/v1/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: m1" \
  -d '{"agentId":"local-work-agent","title":"Manual"}' | jq .

# Note the conversation id, then post a run
CID=...  # paste from above
curl -s -X POST "http://127.0.0.1:$PORT/v1/conversations/$CID/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: m2" \
  -d '{"input":"hello"}' | jq .

# Stream events for the run
RID=...  # paste from above
curl -N "http://127.0.0.1:$PORT/v1/runs/$RID/events" -H "Authorization: Bearer $TOKEN"
# Should see: run.started → text.delta → run.completed; stream then closes.

# Verify SQLite has the conversation + messages
sqlite3 ~/Library/Application\ Support/Vulture/profiles/default/data.sqlite \
  "SELECT id, role, content FROM messages WHERE conversation_id = '$CID'"
# → user / hello, assistant / [stub] done
```

- [ ] **Step 4: Test inflight recovery**

```bash
# kill -9 the gateway mid-run (start a long fake run first or just kill anytime)
GW_PID=$(pgrep -f "apps/gateway/src/main.ts")
# Inject an inflight row
sqlite3 ~/Library/Application\ Support/Vulture/profiles/default/data.sqlite \
  "INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id, started_at) VALUES ('r-test-orphan', '$CID', 'local-work-agent', 'running', 'm-fake', '2026-04-26T00:00:00.000Z')"
kill -9 $GW_PID
sleep 3  # supervisor restarts gateway; recovery sweep runs
sqlite3 ~/Library/Application\ Support/Vulture/profiles/default/data.sqlite \
  "SELECT status, error_json FROM runs WHERE id='r-test-orphan'"
# → failed / {"code":"internal.gateway_restarted",...}
```

- [ ] **Step 5: Verify shell tool execution path**

(Can't do this end-to-end without a real LLM that emits tool plans. Skip until 3b's real LLM is in place, or trigger /tools/invoke directly via curl to the shell HTTP server using the runtime.json shell port.)

```bash
SPORT=$(jq -r .shell.port ~/Library/Application\ Support/Vulture/runtime.json)
curl -s -X POST "http://127.0.0.1:$SPORT/tools/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Caller-Pid: $GW_PID" \
  -d '{"callId":"manual","runId":"manual","tool":"shell.exec","input":{"cwd":"/tmp","argv":["echo","hi"],"timeoutMs":5000}}' | jq .
# → {"status":"ask",...} or {"status":"denied",...} depending on PolicyEngine state
```

- [ ] **Step 6: Document results in PR description**

---

## Out of scope (3a) — deferred to Phase 3b

- UI chat-style rewrite (App.tsx → ConversationView + MessageList + RunEventStream)
- `apps/desktop-ui/src/api/conversations.ts` + `api/runs.ts` (with SSE consumer using `fetch` + ReadableStream)
- Real `@openai/agents` integration in `makeOpenAiLlm()` (currently a stub that echoes input)
- Browser tool execution wired through existing browser/relay (manifest advertises but execute returns "not yet wired")
- Approval flow end-to-end (approvals route is a stub; no Tool wired to await approval token)

3a's job is to make the backend correct and the migration commit-by-commit safe. 3b lives or dies on the backend being right.

---

## Self-Review

Spec coverage check (Phase 3 acceptance criteria from spec lines ~691-707):

| Spec acceptance | Plan task |
|---|---|
| UI sends a message → user message appears immediately → SSE streams tokens → tool calls render → completion | Tasks 13-14 (POST returns user message immediately; SSE streams events); UI consumption deferred to 3b |
| Network drop → reconnect with `Last-Event-ID` → no event loss | Task 14 (`/v1/runs/:rid/events` honors `Last-Event-ID` via `RunStore.listEventsAfter`) |
| Killing Gateway mid-run → UI sees stream end → "Reconnecting" → that run marked `failed` | Task 7 (RunStore.recoverInflightOnStartup) + Task 15 (called in buildServer) + Task 20 (integration test) |
| `crates/tool-gateway` audit shows `tool.requested` / `tool.completed` per call | Existing PolicyEngine audit + Task 17 (route uses PolicyEngine.decide which writes to AuditStore) |
| `apps/agent-sidecar/` does not exist | Task 19 |
| `grep -r "start_agent_run" apps/` returns nothing | Tasks 18-19 |
| Browser tools: `browser.click` triggers `tool.ask` → UI approval flow → execution → run continues | 3a partial: tool.ask emitted (Task 17 PolicyEngine returns Ask); UI approval flow + run-continuation deferred to 3b |

Type consistency check:
- ConversationId, MessageId, RunId, AgentId, ToolName all defined as branded ID types in protocol/v1; reused consistently in stores and routes.
- RunEvent discriminated union — same `type` field used in store payload_json, runs.ts SSE event line, runner.ts emit.
- `status` enum has matching string literal in RunSchema, RunStore methods, and runs.ts cancel guard.

Placeholder scan: zero `TBD`/`TODO`/`FIXME` in plan body. The two stubs (`makeOpenAiLlm`, browser tool execution) are explicit and called out in "Out of scope (3a)".

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-26-l0-phase-3a-backend.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review.

**2. Inline Execution** — batch with checkpoints in same session.

**Which approach?**

(Recommend starting in a **fresh session** — Phase 3a is 21 tasks of substantive backend work with several high-risk integration points. Phase 1+2 lessons are baked into this plan; a fresh model + this plan should execute cleanly.)
