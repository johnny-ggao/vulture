# L3a MCP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a working stdio MCP client so Vulture agents can call local MCP server tools through the OpenAI Agents SDK path.

**Architecture:** Gateway stores profile-level MCP server config in SQLite, manages connected SDK `MCPServerStdio` instances in an `McpClientManager`, wraps discovered MCP tools as SDK function tools with Vulture checkpoints/approval, and exposes CRUD/status routes to the desktop UI. Settings replaces the MCP stub with an operator management page.

**Tech Stack:** Bun, TypeScript, Hono, SQLite, React, OpenAI Agents SDK `MCPServerStdio`, `tool()`, and existing Vulture run/tool event protocol.

---

### Task 1: MCP Protocol Types And Storage

**Files:**
- Create: `apps/gateway/src/persistence/migrations/009_mcp_servers.sql`
- Modify: `apps/gateway/src/persistence/migrate.ts`
- Create: `apps/gateway/src/domain/mcpServerStore.ts`
- Create: `apps/gateway/src/domain/mcpServerStore.test.ts`

- [ ] **Step 1: Write failing storage tests**

Cover create/list/get/update/delete, invalid command, invalid cwd, and disabled trust filtering.

Run: `bun test apps/gateway/src/domain/mcpServerStore.test.ts`

Expected before implementation: FAIL because `mcpServerStore.ts` does not exist.

- [ ] **Step 2: Add migration and store**

Create `mcp_servers` with `id`, `profile_id`, `name`, `transport`, `command`, `args_json`, `cwd`, `env_json`, `trust`, `enabled`, `created_at`, `updated_at`. Implement validation with absolute existing `cwd` when present, string arrays for args, string map env, and `transport === "stdio"`.

- [ ] **Step 3: Verify storage**

Run: `bun test apps/gateway/src/domain/mcpServerStore.test.ts`

Expected: PASS.

### Task 2: MCP Routes

**Files:**
- Create: `apps/gateway/src/routes/mcpServers.ts`
- Create: `apps/gateway/src/routes/mcpServers.test.ts`
- Modify: `apps/gateway/src/server.ts`

- [ ] **Step 1: Write failing route tests**

Cover:

- `GET /v1/mcp/servers` returns `items`.
- `POST /v1/mcp/servers` creates a server.
- `PATCH /v1/mcp/servers/:id` updates trust/enabled.
- `DELETE /v1/mcp/servers/:id` removes it.
- Invalid config returns 400.

Run: `bun test apps/gateway/src/routes/mcpServers.test.ts`

Expected before route implementation: FAIL with missing route/module.

- [ ] **Step 2: Implement route module**

Wire store methods to Hono routes. Include runtime status fields from the manager when provided; otherwise return disconnected status.

- [ ] **Step 3: Register route in server**

Instantiate `McpServerStore` in `buildServer()` and mount `mcpServersRouter`.

- [ ] **Step 4: Verify routes**

Run: `bun test apps/gateway/src/routes/mcpServers.test.ts`

Expected: PASS.

### Task 3: MCP Client Manager And SDK Tool Wrapping

**Files:**
- Create: `apps/gateway/src/runtime/mcpClientManager.ts`
- Create: `apps/gateway/src/runtime/mcpClientManager.test.ts`
- Modify: `apps/gateway/src/tools/types.ts`

- [ ] **Step 1: Write failing manager tests**

Use fake MCP server instances with `connect`, `close`, `listTools`, and `callTool` methods. Cover disabled servers, failed connect status, tool wrapping, checkpoints, and trust-based approval.

Run: `bun test apps/gateway/src/runtime/mcpClientManager.test.ts`

Expected before implementation: FAIL because manager does not exist.

- [ ] **Step 2: Implement manager**

Add `McpClientManager` that:

- Loads active config from `McpServerStore`.
- Creates SDK `MCPServerStdio` instances by default.
- Keeps status in memory.
- Lists tools from connected servers.
- Wraps MCP tools with `tool({ name, description, parameters, strict: false, needsApproval, execute })`.
- Emits `onCheckpoint` activeTool before invocation and clears it after.
- Calls `server.callTool()` for execution.

- [ ] **Step 3: Verify manager**

Run: `bun test apps/gateway/src/runtime/mcpClientManager.test.ts`

Expected: PASS.

### Task 4: LLM Run Integration

**Files:**
- Modify: `apps/gateway/src/runtime/openaiLlm.ts`
- Modify: `apps/gateway/src/runtime/resolveLlm.ts`
- Modify: `apps/gateway/src/server.ts`
- Modify: `apps/gateway/src/runtime/openaiLlm.test.ts`

- [ ] **Step 1: Write failing run wiring tests**

Add tests proving `defaultRunFactory` merges core tools with MCP tools and preserves existing core tool behavior when MCP tool discovery fails.

Run: `bun test apps/gateway/src/runtime/openaiLlm.test.ts`

Expected before implementation: FAIL for missing MCP tool provider.

- [ ] **Step 2: Add MCP tool provider dependency**

Thread an optional `mcpToolProvider` through `makeLazyLlm`, `makeOpenAILlm`, and `RunFactoryInput`. At run start, await provider output and append it after core tools.

- [ ] **Step 3: Wire server**

Pass `mcpManager.getSdkToolsForRun()` into the lazy LLM. Keep memory extraction LLM tool-free.

- [ ] **Step 4: Verify run integration**

Run: `bun test apps/gateway/src/runtime/openaiLlm.test.ts apps/gateway/src/runtime/resolveLlm.test.ts`

Expected: PASS.

### Task 5: Desktop API And Settings UI

**Files:**
- Create: `apps/desktop-ui/src/api/mcpServers.ts`
- Modify: `apps/desktop-ui/src/App.tsx`
- Modify: `apps/desktop-ui/src/chat/SettingsPage.tsx`
- Create or modify: `apps/desktop-ui/src/chat/SettingsPage.test.tsx`

- [ ] **Step 1: Write failing UI/API tests**

Cover rendering MCP server rows, creating a server via callback, and displaying route errors.

Run: `bun test apps/desktop-ui/src`

Expected before implementation: FAIL because callbacks/UI do not exist.

- [ ] **Step 2: Add desktop API client**

Implement list/create/update/delete/reconnect/tools calls under `/v1/mcp/servers`.

- [ ] **Step 3: Replace Settings stub**

Add server list, form, enabled/trust controls, reconnect/delete actions, and tools preview.

- [ ] **Step 4: Wire App callbacks**

Load and mutate MCP server config through `apiClient`, passing callbacks into `SettingsPage`.

- [ ] **Step 5: Verify UI**

Run: `bun test apps/desktop-ui/src`

Expected: PASS.

### Task 6: Full Verification

**Files:**
- No new files unless fixes are needed.

- [ ] **Step 1: Gateway tests**

Run: `bun test apps/gateway/src`

Expected: all gateway tests pass.

- [ ] **Step 2: UI tests**

Run: `bun test apps/desktop-ui/src`

Expected: all UI tests pass.

- [ ] **Step 3: Typecheck**

Run:

```bash
bun --filter @vulture/gateway typecheck
bun --filter @vulture/desktop-ui typecheck
```

Expected: both pass.

- [ ] **Step 4: Diff check**

Run: `git diff --check`

Expected: no output.
