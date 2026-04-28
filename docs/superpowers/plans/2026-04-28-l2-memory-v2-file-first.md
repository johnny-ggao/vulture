# L2 Memory v2 File-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vulture memory file-first by using Markdown files as canonical memory and SQLite as the searchable index/cache.

**Architecture:** Add a gateway memory file service that owns `MEMORY.md`, `memory/`, migration, indexing, retrieval, and append-only writes. Existing memory routes become compatibility routes over the file service. Memory tools are registered as normal OpenAI Agents SDK tools and the run prompt changes to summary plus retrieval guidance.

**Tech Stack:** Bun, TypeScript, Hono, SQLite, OpenAI Agents JS SDK function tools, React.

---

### Task 1: SQLite schema for file-first memory

**Files:**
- Create: `apps/gateway/src/persistence/migrations/008_memory_files.sql`
- Modify: `apps/gateway/src/persistence/migrate.ts`
- Modify: `apps/gateway/src/persistence/migrate.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add a test to `apps/gateway/src/persistence/migrate.test.ts`:

```ts
test("008 adds file-first memory index tables", () => {
  const db = freshDb();
  applyMigrations(db);

  const memoryFilesColumns = db
    .query("PRAGMA table_info(memory_files)")
    .all() as Array<{ name: string }>;
  const memoryChunksColumns = db
    .query("PRAGMA table_info(memory_chunks)")
    .all() as Array<{ name: string }>;
  const memorySuggestionsColumns = db
    .query("PRAGMA table_info(memory_suggestions)")
    .all() as Array<{ name: string }>;

  expect(memoryFilesColumns.map((c) => c.name)).toContain("content_hash");
  expect(memoryChunksColumns.map((c) => c.name)).toContain("embedding_json");
  expect(memorySuggestionsColumns.map((c) => c.name)).toContain("status");
  expect(currentSchemaVersion(db)).toBe(8);
  db.close();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test apps/gateway/src/persistence/migrate.test.ts
```

Expected: FAIL because `memory_files` does not exist and schema version remains 7.

- [ ] **Step 3: Add migration 008 and wire it**

Create `apps/gateway/src/persistence/migrations/008_memory_files.sql`:

```sql
CREATE TABLE IF NOT EXISTS memory_files (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  UNIQUE(agent_id, path),
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  embedding_json TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY(file_id) REFERENCES memory_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_files_agent ON memory_files(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_agent_path ON memory_chunks(agent_id, path);

CREATE TABLE IF NOT EXISTS memory_suggestions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  conversation_id TEXT,
  content TEXT NOT NULL,
  reason TEXT NOT NULL,
  target_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_suggestions_agent_status
  ON memory_suggestions(agent_id, status, created_at DESC);

INSERT OR IGNORE INTO schema_version(version) VALUES (8);
```

Modify `apps/gateway/src/persistence/migrate.ts` to read `008_memory_files.sql` and add `{ version: 8, sql: init008 }`.

- [ ] **Step 4: Run the migration test and verify GREEN**

Run:

```bash
bun test apps/gateway/src/persistence/migrate.test.ts
```

Expected: PASS.

### Task 2: Memory file store and indexer

**Files:**
- Create: `apps/gateway/src/domain/memoryFileStore.ts`
- Create: `apps/gateway/src/domain/memoryFileStore.test.ts`
- Modify: `apps/gateway/src/runtime/memoryRetrieval.ts`

- [ ] **Step 1: Write failing tests for initialization, migration, indexing, and search**

Create `apps/gateway/src/domain/memoryFileStore.test.ts` with tests that:

- create `MEMORY.md` and `memory/`;
- migrate legacy `MemoryStore` rows into `MEMORY.md` exactly once;
- index Markdown chunks and retrieve by keyword;
- append to `MEMORY.md` and reindex.

Use temporary directories and real SQLite. Assert `MEMORY.md` content and returned chunk content.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test apps/gateway/src/domain/memoryFileStore.test.ts
```

Expected: FAIL because `memoryFileStore.ts` does not exist.

- [ ] **Step 3: Implement `MemoryFileStore`**

Implement:

```ts
export interface MemoryChunk {
  id: string;
  agentId: string;
  path: string;
  heading: string | null;
  content: string;
  keywords: string[];
  embedding: number[] | null;
  startLine: number;
  endLine: number;
  updatedAt: string;
}

export class MemoryFileStore {
  constructor(private readonly opts: {
    db: DB;
    legacy?: MemoryStore;
    embed?: (input: string) => Promise<number[] | null>;
  }) {}

  initializeAgent(agent: Agent): Promise<void>;
  migrateLegacy(agent: Agent): Promise<void>;
  reindexAgent(agent: Agent): Promise<void>;
  listChunks(agentId: string): MemoryChunk[];
  search(agent: Agent, query: string, limit?: number): Promise<RetrievedMemory[]>;
  getChunk(agentId: string, id: string): MemoryChunk | null;
  getFile(agent: Agent, path: string): Promise<{ path: string; content: string }>;
  append(agent: Agent, path: string, content: string): Promise<MemoryChunk[]>;
  contextPrompt(agent: Agent): Promise<string>;
}
```

Use deterministic Markdown chunking by heading. Use `normalizeMemoryKeywords` and `retrieveRelevantMemories` from `memoryRetrieval.ts` for search.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bun test apps/gateway/src/domain/memoryFileStore.test.ts
```

Expected: PASS.

### Task 3: Compatibility memory routes

**Files:**
- Modify: `apps/gateway/src/routes/memories.ts`
- Modify: `apps/gateway/src/routes/memories.test.ts`
- Modify: `apps/desktop-ui/src/api/memories.ts`

- [ ] **Step 1: Write failing route tests**

Update route tests so `POST /v1/agents/:agentId/memories` appends to `MEMORY.md`, `GET` returns indexed chunks, and `DELETE` returns `409` for file-backed memory chunks instead of silently editing Markdown.

- [ ] **Step 2: Run the focused route test and verify RED**

Run:

```bash
bun test apps/gateway/src/routes/memories.test.ts
```

Expected: FAIL because routes still use only `MemoryStore`.

- [ ] **Step 3: Update route dependencies**

Change `MemoriesDeps` to accept `memoryFiles?: MemoryFileStore` plus legacy `memories`. If `memoryFiles` is present:

- `GET` initializes/reindexes and returns chunks.
- `POST` appends to `MEMORY.md`.
- `DELETE` returns `409` for file-backed chunk ids.

Keep the legacy path for tests or older wiring that does not pass `memoryFiles`.

- [ ] **Step 4: Run route tests and verify GREEN**

Run:

```bash
bun test apps/gateway/src/routes/memories.test.ts
```

Expected: PASS.

### Task 4: Memory SDK tools and prompt strategy

**Files:**
- Modify: `apps/gateway/src/tools/types.ts`
- Modify: `apps/gateway/src/tools/coreTools.ts`
- Modify: `apps/gateway/src/runtime/gatewayLocalTools.ts`
- Modify: `apps/gateway/src/runtime/gatewayLocalTools.test.ts`
- Modify: `apps/gateway/src/server.ts`
- Modify: `apps/gateway/src/routes/runs.test.ts`

- [ ] **Step 1: Write failing tool tests**

Add tests in `gatewayLocalTools.test.ts` that:

- `memory_search` returns only active agent memory;
- `memory_get` rejects unsafe paths;
- `memory_append` requires approval and appends/reindexes with approval.

- [ ] **Step 2: Run the focused tool tests and verify RED**

Run:

```bash
bun test apps/gateway/src/runtime/gatewayLocalTools.test.ts
```

Expected: FAIL because memory tools are not implemented.

- [ ] **Step 3: Register tools**

Add schemas and tool specs in `coreTools.ts`:

- `memory_search`
- `memory_get`
- `memory_append`

Add `"memory"` to `GatewayToolCategory`.

- [ ] **Step 4: Execute tools through gateway local tools**

Add `memory?: GatewayMemoryTools` to `GatewayLocalToolsOptions` and execute the three memory tools through injected closures from `server.ts`.

- [ ] **Step 5: Update server wiring**

Instantiate `MemoryFileStore`, pass it to routes, local tools, and `contextPromptForRun`. Replace old `memoryPromptForRun` top-k injection with `memoryFileStore.contextPrompt(agent)`.

- [ ] **Step 6: Run tool and run route tests and verify GREEN**

Run:

```bash
bun test apps/gateway/src/runtime/gatewayLocalTools.test.ts apps/gateway/src/routes/runs.test.ts
```

Expected: PASS.

### Task 5: Settings memory UI

**Files:**
- Modify: `apps/desktop-ui/src/api/memories.ts`
- Modify: `apps/desktop-ui/src/chat/SettingsPage.tsx`
- Modify: `apps/desktop-ui/src/App.integration.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Update the memory tab integration test to expect file-backed memory labels such as memory root/index status when returned by the API, and to keep manual add working.

- [ ] **Step 2: Run the focused UI test and verify RED**

Run:

```bash
bun test apps/desktop-ui/src/App.integration.test.tsx
```

Expected: FAIL because the UI does not display file-backed state yet.

- [ ] **Step 3: Update memory API and UI**

Extend `Memory` view with optional fields:

- `path`
- `heading`
- `startLine`
- `endLine`
- `source`

Show path/heading in cards. Keep manual add and delete UI compatible, but display delete errors from `409` cleanly.

- [ ] **Step 4: Run UI test and verify GREEN**

Run:

```bash
bun test apps/desktop-ui/src/App.integration.test.tsx
```

Expected: PASS.

### Task 6: Full verification and commit

**Files:**
- All files modified by previous tasks.

- [ ] **Step 1: Run gateway tests**

Run:

```bash
bun test apps/gateway/src
```

Expected: PASS.

- [ ] **Step 2: Run desktop UI tests**

Run:

```bash
bun test apps/desktop-ui/src
```

Expected: PASS.

- [ ] **Step 3: Run typechecks**

Run:

```bash
bun --filter @vulture/gateway typecheck
bun --filter @vulture/desktop-ui typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git status --short
git add apps/gateway apps/desktop-ui docs/superpowers/plans/2026-04-28-l2-memory-v2-file-first.md
git commit -m "Add file-first memory tools"
```

Expected: commit succeeds.

