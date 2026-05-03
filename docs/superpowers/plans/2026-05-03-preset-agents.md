# Preset Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `local-work-agent` seed with two preset agents — `Vulture` (general, evolved from `local-work-agent` keeping the same ID) and `Vulture Coding` (new, `id="coding-agent"`) — and add a UI nudge in `ChatView` so coding-agent users notice when they're still in the private workspace and need to switch to a real project directory.

**Architecture:** All gateway logic lives in `apps/gateway/src/domain/agentStore.ts`. The single `DEFAULT_AGENT` constant becomes a `DEFAULT_AGENTS` array; `ensureDefault()` is renamed to `ensureDefaults()` and iterates. Per-preset agent-core templates (`USER.md` for both, `IDENTITY.md` for coding) are emitted by `agentCoreTemplates()` based on `agent.id`; the existing "only-if-missing" file-write semantics protect user edits. The UI side adds (a) an `isUsingPrivateWorkspace(id)` query on the agent route, (b) a dismissible banner in `ChatView` that surfaces only for coding-agent on a private workspace, (c) an editable workspace path input in `OverviewTab`, and (d) an `initialTab` prop on `AgentEditModal` so the banner can deep-link.

**Tech Stack:** TypeScript / Bun (gateway), React + TS (`apps/desktop-ui`), Hono routing, SQLite via `bun:sqlite`. Tests via `bun test` (gateway) and `@testing-library/react` (UI).

**Source of truth:** [docs/superpowers/specs/2026-05-03-preset-agents-design.md](../specs/2026-05-03-preset-agents-design.md). Refer back to the spec when a task description is ambiguous.

**Repo conventions:**
- Run `bun test` not `npm test` / `node`.
- All test files sit next to source under `*.test.ts(x)`.
- Conventional commits: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
- Do NOT use `git commit -am` (sweeps unrelated WT changes). Always `git add <specific files>`.
- Worktree branch is `feat/preset-agents` (create from `feat/coding-foundation` after the foundation lands, OR from latest `main` if the foundation already merged — see Phase 0).

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `apps/desktop-ui/src/chat/CodingAgentBanner.tsx` | Dismissible banner component shown when `agentId === "coding-agent"` AND workspace is the private default. |
| `apps/desktop-ui/src/chat/CodingAgentBanner.test.tsx` | Show/hide conditions, dismiss, click→callback. |

### Modified files
| File | Change |
|---|---|
| `apps/gateway/src/domain/agentStore.ts` | `DEFAULT_AGENT` → `DEFAULT_AGENTS` array; `ensureDefault` → `ensureDefaults` iterating both presets; `ensureDefaultToolsCurrent` / `ensureDefaultWorkspaceCurrent` extended to iterate; `agentCoreTemplates` accepts preset-aware overrides for `USER.md` and `IDENTITY.md`. New public `isUsingPrivateWorkspace(id)` method. |
| `apps/gateway/src/domain/agentStore.test.ts` | Cover both presets seed, idempotent reconcile, USER.md/IDENTITY.md content + existence-only behavior, delete-then-list re-seeds, avatar/reasoning persistence, `isUsingPrivateWorkspace`. |
| `apps/gateway/src/routes/agents.ts` | New endpoint `GET /agents/:id/workspace-status` returning `{ isPrivate: boolean }` (or include in existing list/get response — see Task 3). |
| `apps/gateway/src/routes/agents.test.ts` | Cover the new endpoint. |
| `apps/desktop-ui/src/api/agents.ts` | TS client for the workspace-status endpoint. |
| `apps/desktop-ui/src/chat/AgentEditModal.tsx` | New optional prop `initialTab?: AgentsTab`; `useState(initialTab ?? "overview")`. |
| `apps/desktop-ui/src/chat/AgentEditModal.test.tsx` | Confirm `initialTab` initializes the active tab. |
| `apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx` | Replace static workspace `InfoBlock` with an editable workspace input + 保存 button that calls `onSaveWorkspace(path)` (new prop, threaded down). |
| `apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.test.tsx` | Edit + save workspace flow. |
| `apps/desktop-ui/src/chat/ChatView.tsx` | Render `<CodingAgentBanner>` when conditions met; banner click triggers `onOpenAgentEdit?.(agentId, "overview")` (new prop). |
| `apps/desktop-ui/src/chat/ChatView.test.tsx` | Banner shows for coding-agent in private workspace; hides otherwise; dismiss persists per session; click invokes the open callback. |
| `apps/desktop-ui/src/chat/AgentsPage.tsx` (or wherever modal opening lives) | Wire the open-from-banner flow: when a deep-link request arrives, set `selectedAgent` + `initialTab="overview"` and open the modal. |

### Out of scope (per spec)
- Preset team / handoff graph.
- Tauri folder picker integration. The OverviewTab workspace input is plain text; users paste/type the path. Folder picker is a follow-up.
- Conditional reconciliation ("overwrite only when value matches a known prior default"). Forced overwrite is acceptable in dev.
- i18n beyond the Chinese banner copy.

---

## Phase 0 — Worktree setup

### Task 0: Create the worktree on the right base

**Files:** none.

- [ ] **Step 1: Determine the base branch**

If the foundation branch (`feat/coding-foundation`) is still un-merged, branch from it. If it merged into `main`, branch from `main`. Check with:

```bash
git branch -a | grep -E "feat/coding-foundation|main"
git log --oneline main..feat/coding-foundation 2>/dev/null | head -3
```

If the second command returns commits, foundation is unmerged. Branch from `feat/coding-foundation` so this work sees the new tools / skills.

- [ ] **Step 2: Create the worktree**

```bash
# Adjust base as determined in Step 1.
BASE=feat/coding-foundation     # or: main
git worktree add -b feat/preset-agents .claude/worktrees/preset-agents "$BASE"
cd .claude/worktrees/preset-agents
bun install
```

- [ ] **Step 3: Verify clean baseline**

```bash
bun test apps/gateway/src/domain/agentStore.test.ts
```

Expected: all existing tests pass. This is the regression baseline for this plan.

No commit for Task 0.

---

## Phase 1 — Backend: agentStore presets

### Task 1: Add `DEFAULT_AGENTS` array + `ensureDefaults()` skeleton

**Files:**
- Modify: `apps/gateway/src/domain/agentStore.ts`
- Modify: `apps/gateway/src/domain/agentStore.test.ts`

- [ ] **Step 1: Read the current `DEFAULT_AGENT` + reconcile call sites**

```bash
grep -n "DEFAULT_AGENT\|ensureDefault\b\|ensureDefaultToolsCurrent\|ensureDefaultWorkspaceCurrent" apps/gateway/src/domain/agentStore.ts
```

Note the four call sites of `ensureDefault()` (in `list`, `get`, `save`, `delete`) and the two helpers `ensureDefaultToolsCurrent` and `ensureDefaultWorkspaceCurrent` that operate on `DEFAULT_AGENT.id`.

- [ ] **Step 2: Write the failing tests**

Append to `agentStore.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("preset agents seed", () => {
  test("first list seeds both Vulture and Vulture Coding", () => {
    const store = makeFreshStore();   // existing test helper; if not present, look at the file's setup pattern
    const agents = store.list();
    const ids = new Set(agents.map((a) => a.id));
    expect(ids.has("local-work-agent")).toBe(true);
    expect(ids.has("coding-agent")).toBe(true);
    const general = agents.find((a) => a.id === "local-work-agent")!;
    const coding = agents.find((a) => a.id === "coding-agent")!;
    expect(general.name).toBe("Vulture");
    expect(coding.name).toBe("Vulture Coding");
    expect(general.reasoning).toBe("medium");
    expect(coding.reasoning).toBe("high");
    expect(general.avatar).toBe("compass");
    expect(coding.avatar).toBe("circuit");
  });

  test("ensureDefaults is idempotent — repeated list calls do not duplicate", () => {
    const store = makeFreshStore();
    store.list();
    store.list();
    store.list();
    const agents = store.list();
    expect(agents.filter((a) => a.id === "local-work-agent").length).toBe(1);
    expect(agents.filter((a) => a.id === "coding-agent").length).toBe(1);
  });

  test("deleting a preset re-seeds it on next list", () => {
    const store = makeFreshStore();
    store.list();
    // Both presets exist now.
    expect(store.list().length).toBeGreaterThanOrEqual(2);
    store.delete("coding-agent");
    expect(store.list().find((a) => a.id === "coding-agent")).toBeDefined();   // re-seeded
  });
});
```

If `makeFreshStore` doesn't exist, copy the setup pattern from existing tests (likely `mkdtempSync` + `new Database(":memory:")` or similar). Verify by reading the top of `agentStore.test.ts`.

- [ ] **Step 3: Run — RED**

```bash
bun test apps/gateway/src/domain/agentStore.test.ts
```

Expected: FAIL on the new "preset agents seed" describe block (no `coding-agent` row, names not matching).

- [ ] **Step 4: Refactor `DEFAULT_AGENT` into `DEFAULT_AGENTS`**

Replace lines 74-93 (the `DEFAULT_AGENT: SaveAgentRequest = {...}` definition) with:

```typescript
const PRESET_GENERAL_INSTRUCTIONS = [
  "You are Vulture, a local-first general assistant.",
  "Complete the user's task directly; do not stall with standby phrases.",
  "Inspect files and run tools to ground your answers — never claim a local action ran unless a tool result confirms it.",
  "For workspace questions, read the directory before summarizing.",
  "When the user is exploring an idea, ask focused clarifying questions before committing to an answer.",
].join(" ");

const PRESET_CODING_INSTRUCTIONS = [
  "You are Vulture Coding, an engineering partner working inside a code repository.",
  "Always read before editing; never invent APIs, file paths, or function signatures — confirm with the read or search tools first.",
  "Prefer small, focused changes over sweeping rewrites; respect existing patterns in the repo.",
  "Verify your work with builds, tests, or type-checks before claiming a change is complete.",
  "When fixing bugs, find the root cause; do not paper over symptoms.",
  "For risky operations (destructive shell, dependency changes, force pushes), surface the plan before executing.",
].join(" ");

const PRESET_GENERAL: SaveAgentRequest = {
  id: "local-work-agent",
  name: "Vulture",
  description: "通用助手——日常工作、写作、研究、问答",
  model: "gpt-5.4",
  reasoning: "medium",
  toolPreset: "full",
  toolInclude: [],
  toolExclude: [],
  tools: [...AGENT_TOOL_NAMES],
  handoffAgentIds: [],
  avatar: "compass",
  instructions: PRESET_GENERAL_INSTRUCTIONS,
};

const PRESET_CODING: SaveAgentRequest = {
  id: "coding-agent",
  name: "Vulture Coding",
  description: "工程伙伴——面向代码仓库的开发与验证",
  model: "gpt-5.4",
  reasoning: "high",
  toolPreset: "full",
  toolInclude: [],
  toolExclude: [],
  tools: [...AGENT_TOOL_NAMES],
  handoffAgentIds: [],
  avatar: "circuit",
  instructions: PRESET_CODING_INSTRUCTIONS,
};

const DEFAULT_AGENTS: readonly SaveAgentRequest[] = [PRESET_GENERAL, PRESET_CODING];
```

- [ ] **Step 5: Rename `ensureDefault` → `ensureDefaults`, iterate**

Replace the body of the existing `private ensureDefault()` (line ~201) with:

```typescript
private ensureDefaults(): void {
  for (const preset of DEFAULT_AGENTS) {
    const existingRow = this.db
      .query("SELECT * FROM agents WHERE id = ?")
      .get(preset.id) as AgentRow | undefined;
    if (!existingRow) {
      this._save(preset);
    }
  }
  // Migration / reconcile passes still run on every call.
  this.ensureDefaultToolsCurrent();
  this.ensureLegacyPrivateWorkspacesCurrent();
  this.ensureDefaultWorkspaceCurrent();
  this.ensureAgentLayoutsCurrent();
  this.ensurePresetFieldsCurrent();   // NEW — see Task 2
}
```

Update all four call sites (`list`, `get`, `save`, `delete`) from `this.ensureDefault()` to `this.ensureDefaults()`.

- [ ] **Step 6: Iterate `ensureDefaultToolsCurrent` and `ensureDefaultWorkspaceCurrent` over both presets**

Both helpers currently single-target `DEFAULT_AGENT.id`. Convert each to loop:

```typescript
private ensureDefaultToolsCurrent(): void {
  for (const preset of DEFAULT_AGENTS) {
    const existingRow = this.db
      .query("SELECT * FROM agents WHERE id = ?")
      .get(preset.id) as AgentRow | undefined;
    if (!existingRow) continue;
    const existingTools = JSON.parse(existingRow.tools) as string[];
    const merged = [...new Set([...existingTools, ...AGENT_TOOL_NAMES])];
    if (merged.length === existingTools.length) continue;
    const policy = toolPolicyFromSaveRequest({
      ...preset,
      tools: merged as AgentToolName[],
    });
    this.db
      .query("UPDATE agents SET tools = ?, tool_preset = ?, tool_include_json = ?, tool_exclude_json = ?, updated_at = ? WHERE id = ?")
      .run(
        JSON.stringify(policy.tools),
        policy.toolPreset,
        JSON.stringify(policy.toolInclude),
        JSON.stringify(policy.toolExclude),
        nowIso8601(),
        preset.id,
      );
  }
}

private ensureDefaultWorkspaceCurrent(): void {
  for (const preset of DEFAULT_AGENTS) {
    const existingRow = this.db
      .query("SELECT * FROM agents WHERE id = ?")
      .get(preset.id) as AgentRow | undefined;
    if (!existingRow) continue;
    // ...existing reconcile body, but replace every `DEFAULT_AGENT` reference with `preset`...
  }
}
```

(For the second helper, the existing body uses `DEFAULT_AGENT.id` and `DEFAULT_AGENT.name` in several places — replace each with `preset.id` / `preset.name`.)

- [ ] **Step 7: Add `ensurePresetFieldsCurrent()` to force-overwrite preset DB fields**

Per Confirmed Decision #5 in the spec, every `ensureDefaults()` rewrites preset row fields. Workspace is preserved. New private method:

```typescript
private ensurePresetFieldsCurrent(): void {
  for (const preset of DEFAULT_AGENTS) {
    const existingRow = this.db
      .query("SELECT * FROM agents WHERE id = ?")
      .get(preset.id) as AgentRow | undefined;
    if (!existingRow) continue;
    const policy = toolPolicyFromSaveRequest(preset);
    this.db
      .query(
        `UPDATE agents SET
          name=?, description=?, model=?, reasoning=?,
          tools=?, tool_preset=?, tool_include_json=?, tool_exclude_json=?,
          skills=?, handoff_agent_ids_json=?,
          instructions=?, avatar=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        preset.name,
        preset.description,
        preset.model,
        preset.reasoning,
        JSON.stringify(policy.tools),
        policy.toolPreset,
        JSON.stringify(policy.toolInclude),
        JSON.stringify(policy.toolExclude),
        preset.skills === undefined ? null : JSON.stringify(preset.skills),
        JSON.stringify(preset.handoffAgentIds ?? []),
        preset.instructions,
        preset.avatar ?? null,
        nowIso8601(),
        preset.id,
      );
  }
}
```

Note: this writes ALL preset-defining fields except workspace. Workspace continues to be reconciled (and preserved if user changed it) by `ensureDefaultWorkspaceCurrent`.

- [ ] **Step 8: Run — GREEN**

```bash
bun test apps/gateway/src/domain/agentStore.test.ts
```

Expected: all new tests pass + existing tests pass. Typecheck:

```bash
cd apps/gateway && bun run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add apps/gateway/src/domain/agentStore.ts apps/gateway/src/domain/agentStore.test.ts
git commit -m "feat(gateway): seed Vulture + Vulture Coding presets via DEFAULT_AGENTS array"
```

---

### Task 2: Per-preset agent-core templates (USER.md + IDENTITY.md)

**Files:**
- Modify: `apps/gateway/src/domain/agentStore.ts` (extend `agentCoreTemplates`).
- Modify: `apps/gateway/src/domain/agentStore.test.ts` (cover content).

- [ ] **Step 1: Write the failing tests**

Append to `agentStore.test.ts`:

```typescript
test("Vulture (general) seeds USER.md with default-Chinese preferences", () => {
  const store = makeFreshStore();
  store.list();
  const file = store.readAgentCoreFile("local-work-agent", "USER.md");
  expect(file.content).toContain("中文");
  expect(file.content).toContain("Default language");
});

test("Vulture (general) does NOT seed IDENTITY.md with engineering principles", () => {
  const store = makeFreshStore();
  store.list();
  const file = store.readAgentCoreFile("local-work-agent", "IDENTITY.md");
  // Generic skeleton, not the coding identity. Should not mention TDD.
  expect(file.content.toLowerCase()).not.toContain("test-driven");
});

test("Vulture Coding seeds IDENTITY.md with engineering principles", () => {
  const store = makeFreshStore();
  store.list();
  const file = store.readAgentCoreFile("coding-agent", "IDENTITY.md");
  expect(file.content).toContain("Vulture Coding");
  expect(file.content.toLowerCase()).toContain("test-driven");
  expect(file.content.toLowerCase()).toContain("immutable");
});

test("once IDENTITY.md exists for coding-agent, ensureDefaults does not overwrite user edits", () => {
  const store = makeFreshStore();
  store.list();
  store.writeAgentCoreFile("coding-agent", "IDENTITY.md", "# user override\n");
  store.list();
  const file = store.readAgentCoreFile("coding-agent", "IDENTITY.md");
  expect(file.content).toBe("# user override\n");
});

test("Vulture Coding seeds USER.md with the same Chinese preferences as Vulture", () => {
  const store = makeFreshStore();
  store.list();
  const general = store.readAgentCoreFile("local-work-agent", "USER.md");
  const coding = store.readAgentCoreFile("coding-agent", "USER.md");
  expect(general.content).toBe(coding.content);
});
```

- [ ] **Step 2: Run — RED**

```bash
bun test apps/gateway/src/domain/agentStore.test.ts
```

Expected: FAIL on the new tests because `agentCoreTemplates` emits identical generic content for all agents.

- [ ] **Step 3: Extend `agentCoreTemplates` with preset-aware overrides**

Replace the `USER.md` and `IDENTITY.md` entries inside `agentCoreTemplates` (around lines 860-872):

```typescript
"IDENTITY.md": agent.id === "coding-agent"
  ? [
      "# Identity",
      "",
      "You are Vulture Coding, the engineering counterpart of Vulture.",
      "",
      "Working principles:",
      "- Test-driven when feasible: write the failing test first, then the implementation.",
      "- Small files, small functions; high cohesion, low coupling.",
      "- Immutable data flow; no in-place mutation of arguments.",
      "- Validate inputs at boundaries; trust internal contracts.",
      "- When in doubt, read the code rather than guess.",
      "",
    ].join("\n")
  : [
      // Existing generic skeleton for non-coding agents.
      "# IDENTITY.md",
      "",
      `- **Name:** ${agent.name}`,
      `- **Role:** ${agent.description.trim() || "Vulture agent"}`,
      "",
    ].join("\n"),
"USER.md": agent.id === "coding-agent" || agent.id === "local-work-agent"
  ? [
      "# User Preferences",
      "",
      "- Default language: 中文 (Chinese). Switch to English only when the user writes in English.",
      "- Style: concise, no filler greetings, no trailing summaries when the diff or output already speaks for itself.",
      "",
    ].join("\n")
  : [
      // Existing generic skeleton for user-created agents.
      "# USER.md",
      "",
      "Capture durable user preferences here when the user explicitly asks you to remember them.",
      "",
    ].join("\n"),
```

This keeps non-preset agents unchanged.

- [ ] **Step 4: Run — GREEN**

```bash
bun test apps/gateway/src/domain/agentStore.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd apps/gateway && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/domain/agentStore.ts apps/gateway/src/domain/agentStore.test.ts
git commit -m "feat(gateway): preset-aware USER.md + IDENTITY.md content for Vulture Coding"
```

---

### Task 3: `isUsingPrivateWorkspace(id)` API + HTTP route

**Files:**
- Modify: `apps/gateway/src/domain/agentStore.ts` — expose new public method.
- Modify: `apps/gateway/src/domain/agentStore.test.ts` — cover the method.
- Modify: `apps/gateway/src/routes/agents.ts` — add a GET endpoint OR include the field in the existing `GET /agents` response.
- Modify: `apps/gateway/src/routes/agents.test.ts` — cover the route.
- Modify: `apps/desktop-ui/src/api/agents.ts` — TS client.

- [ ] **Step 1: Decide where to surface the field**

Two options:

A. New endpoint `GET /agents/:id/workspace-status` returning `{ isPrivate: boolean }`.

B. Add a top-level `isPrivateWorkspace?: boolean` field to the existing `Agent` DTO so it's returned by `GET /agents` and `GET /agents/:id` automatically.

Choose **B** — it avoids an extra round-trip on every `ChatView` render and keeps the data model simpler.

- [ ] **Step 2: Add the public method to AgentStore (test first)**

In `agentStore.test.ts`:

```typescript
test("isUsingPrivateWorkspace returns true for freshly seeded coding-agent", () => {
  const store = makeFreshStore();
  store.list();
  expect(store.isUsingPrivateWorkspace("coding-agent")).toBe(true);
  expect(store.isUsingPrivateWorkspace("local-work-agent")).toBe(true);
});

test("isUsingPrivateWorkspace returns false after the user changes the workspace", () => {
  const store = makeFreshStore();
  store.list();
  // Save the agent with a custom workspace path.
  const customPath = mkdtempSync(join(tmpdir(), "custom-ws-"));
  store.save({
    ...store.get("coding-agent")!,
    workspace: { id: "anything", name: "custom", path: customPath },
  } as SaveAgentRequest);
  expect(store.isUsingPrivateWorkspace("coding-agent")).toBe(false);
  rmSync(customPath, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run — RED**

```bash
bun test apps/gateway/src/domain/agentStore.test.ts
```

Expected: FAIL on missing method.

- [ ] **Step 4: Implement the public method**

`isManagedPrivateWorkspace(agentId, workspace)` already exists as a private helper around line 532. Promote it via a public wrapper:

```typescript
isUsingPrivateWorkspace(id: string): boolean {
  this.ensureDefaults();
  const agent = this.get(id);
  if (!agent) return false;
  return this.isManagedPrivateWorkspace(id, agent.workspace as Workspace);
}
```

(Place this method in the public-API section near `agentRootPath`, line ~166.)

- [ ] **Step 5: Run — GREEN**

```bash
bun test apps/gateway/src/domain/agentStore.test.ts
```

- [ ] **Step 6: Surface the field on the Agent DTO**

Look at `apps/gateway/src/routes/agents.ts` and the Agent DTO. Where the route serializes an Agent for the response, augment with `isPrivateWorkspace: store.isUsingPrivateWorkspace(agent.id)`. The DTO type lives in `packages/protocol/src/v1/agent.ts` — add an optional field there too:

```typescript
// In packages/protocol/src/v1/agent.ts:
export const AgentSchema = z.object({
  // ...existing fields...
  isPrivateWorkspace: z.boolean().optional(),
});
```

- [ ] **Step 7: Add a test in `agents.test.ts`**

```typescript
test("GET /agents returns isPrivateWorkspace=true for freshly seeded presets", async () => {
  const { app } = makeTestApp();   // existing helper
  const res = await app.request("/v1/agents");
  const body = await res.json();
  const coding = body.agents.find((a: { id: string }) => a.id === "coding-agent");
  expect(coding.isPrivateWorkspace).toBe(true);
});
```

(Match the existing test setup style — read 2-3 nearby tests to find the right helpers.)

- [ ] **Step 8: Run all gateway tests**

```bash
cd apps/gateway && bun test
```

- [ ] **Step 9: Update the TS UI client**

In `apps/desktop-ui/src/api/agents.ts`, add `isPrivateWorkspace?: boolean` to the local `Agent` shape (mirroring the protocol).

- [ ] **Step 10: Run UI typecheck**

```bash
cd apps/desktop-ui && bun run typecheck
```

- [ ] **Step 11: Commit**

```bash
git add \
  apps/gateway/src/domain/agentStore.ts \
  apps/gateway/src/domain/agentStore.test.ts \
  apps/gateway/src/routes/agents.ts \
  apps/gateway/src/routes/agents.test.ts \
  packages/protocol/src/v1/agent.ts \
  apps/desktop-ui/src/api/agents.ts
git commit -m "feat(gateway): expose isPrivateWorkspace on agent DTO"
```

(If the OpenAPI artifact regen is needed because protocol schema changed, run `cd packages/protocol && bun run openapi` and add `packages/protocol/openapi/v1.json` to the same commit — `protocol/src/openapi/v1.test.ts` will fail otherwise.)

---

## Phase 2 — UI: editable workspace + banner

### Task 4: `AgentEditModal` `initialTab` prop

**Files:**
- Modify: `apps/desktop-ui/src/chat/AgentEditModal.tsx`
- Modify: `apps/desktop-ui/src/chat/AgentEditModal.test.tsx`

- [ ] **Step 1: Add a failing test**

In `AgentEditModal.test.tsx`:

```typescript
test("initialTab prop sets the active tab on mount", async () => {
  const { container } = render(
    <AgentEditModal
      open={true}
      agent={fixtureAgent}                 // existing fixture
      agents={[fixtureAgent]}
      toolGroups={[]}
      onClose={() => {}}
      onSave={async () => {}}
      initialTab="core"
    />,
  );
  // The "Core" tab button should have aria-selected=true. Match the
  // existing test idiom — look at how other tests assert tab state.
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent)
    .toMatch(/core|核心/i);
});
```

- [ ] **Step 2: Run — RED**

```bash
bun test apps/desktop-ui/src/chat/AgentEditModal.test.tsx
```

- [ ] **Step 3: Add the prop**

In `AgentEditModal.tsx` — modify the props interface and the `useState` initializer:

```typescript
export interface AgentEditModalProps {
  open: boolean;
  agent: Agent | null;
  agents: ReadonlyArray<Agent>;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  authStatus?: AuthStatusView | null;
  onClose: () => void;
  onSave?: (id: string, patch: AgentConfigPatch) => Promise<void>;
  onCreate?: (patch: AgentConfigPatch) => Promise<void>;
  onListFiles?: (id: string) => Promise<AgentCoreFilesResponse>;
  onLoadFile?: (id: string, name: string) => Promise<string>;
  onSaveFile?: (id: string, name: string, content: string) => Promise<void>;
  /** When provided, opens the modal on this tab. Otherwise defaults to "overview". */
  initialTab?: AgentsTab;
}
```

Replace `useState<AgentsTab>("overview")` with `useState<AgentsTab>(props.initialTab ?? "overview")`.

If the modal currently has a `useEffect` that resets the tab to "overview" on `agent` change (line 137: `setTab("overview")`), update it to honor `props.initialTab` when present:

```typescript
useEffect(() => {
  setTab(props.initialTab ?? "overview");
}, [agent?.id, props.initialTab]);
```

- [ ] **Step 4: Run — GREEN**

```bash
bun test apps/desktop-ui/src/chat/AgentEditModal.test.tsx
```

- [ ] **Step 5: Typecheck**

```bash
cd apps/desktop-ui && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop-ui/src/chat/AgentEditModal.tsx apps/desktop-ui/src/chat/AgentEditModal.test.tsx
git commit -m "feat(ui): AgentEditModal initialTab prop for deep-linking"
```

---

### Task 5: Editable workspace path in `OverviewTab`

**Files:**
- Modify: `apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx`
- Modify: `apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.test.tsx`

- [ ] **Step 1: Survey current InfoBlock + Draft fields**

```bash
grep -n "InfoBlock\|workspace\.path\|workspace:" apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx
grep -n "interface OverviewTabProps\|onChange" apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx | head
```

Note that the workspace `InfoBlock` (line 124) is read-only. The OverviewTab takes `draft: Draft` and `onChange: (next: Draft) => void`; we need to confirm whether `Draft` includes `workspace`. If yes, the UI just needs an editable input bound to `draft.workspace.path`. If no, the change needs to thread up to the modal's save flow.

```bash
grep -n "type Draft\|interface Draft\|workspace" apps/desktop-ui/src/chat/editAgentTabs/draft.ts
```

- [ ] **Step 2: Write the failing test**

In `OverviewTab.test.tsx`:

```typescript
test("workspace input is editable and updates the draft on change", async () => {
  const onChange = mock(() => {});
  const draft = draftFromAgent(fixtureAgentWithPrivateWorkspace);
  render(
    <OverviewTab
      draft={draft}
      onChange={onChange}
      agent={fixtureAgentWithPrivateWorkspace}
      authStatus={null}
      // ...other required props from existing tests...
    />,
  );
  const input = screen.getByLabelText(/workspace|工作区/i) as HTMLInputElement;
  expect(input.value).toBe(fixtureAgentWithPrivateWorkspace.workspace.path);
  fireEvent.change(input, { target: { value: "/Users/me/projects/myrepo" } });
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      workspace: expect.objectContaining({ path: "/Users/me/projects/myrepo" }),
    }),
  );
});

test("workspace input is read-only in create mode", async () => {
  const onChange = mock(() => {});
  render(
    <OverviewTab
      draft={emptyDraft}
      onChange={onChange}
      agent={null}     // create mode
      // ...
    />,
  );
  // In create mode, the workspace section either hides entirely or
  // shows a disabled input. Match what feels right; the existing
  // pattern is to hide id-bound info in create mode.
  expect(screen.queryByLabelText(/workspace|工作区/i)).toBeNull();
});
```

(Match the file's existing test style — read 2-3 existing tests in the file before writing these.)

- [ ] **Step 3: Run — RED**

```bash
bun test apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.test.tsx
```

- [ ] **Step 4: Verify Draft has `workspace`**

If `Draft` doesn't include workspace today, extend it in `apps/desktop-ui/src/chat/editAgentTabs/draft.ts`:

```typescript
export interface Draft {
  // ...existing fields...
  workspace?: { id: string; name: string; path: string };
}

export function draftFromAgent(agent: Agent | null): Draft {
  return {
    // ...existing field maps...
    workspace: agent ? { id: agent.workspace.id, name: agent.workspace.name, path: agent.workspace.path } : undefined,
  };
}
```

Also confirm that the modal's save flow includes `draft.workspace` when calling `onSave(id, patch)`. If not, extend the patch construction to include it.

- [ ] **Step 5: Replace the static InfoBlock with an editable input**

Around line 124:

```tsx
{agent ? (
  <Field label="工作区" hint="智能体执行 read/write/grep/glob 等本地工具时使用的根目录。">
    <input
      type="text"
      className="agent-edit-input"
      value={draft.workspace?.path ?? agent.workspace.path}
      onChange={(e) =>
        onChange({
          ...draft,
          workspace: {
            id: draft.workspace?.id ?? agent.workspace.id,
            name: draft.workspace?.name ?? agent.workspace.name,
            path: e.target.value,
          },
        })
      }
      spellCheck={false}
      autoComplete="off"
      placeholder="/Users/you/Code/your-project"
    />
  </Field>
) : null}
```

(Use the same `Field` / `<input>` / class-name conventions from elsewhere in the file. Read a neighbor field — e.g. the description field — for the right look.)

- [ ] **Step 6: Run — GREEN**

```bash
bun test apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.test.tsx
```

- [ ] **Step 7: Typecheck**

```bash
cd apps/desktop-ui && bun run typecheck
```

- [ ] **Step 8: Manual smoke (optional)**

If a dev server is convenient, start it and verify the workspace field renders, edits persist on save, and a non-private path makes the banner disappear (banner is implemented in Task 7, so skip until then if you're going strictly task-by-task).

- [ ] **Step 9: Commit**

```bash
git add \
  apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.tsx \
  apps/desktop-ui/src/chat/editAgentTabs/OverviewTab.test.tsx \
  apps/desktop-ui/src/chat/editAgentTabs/draft.ts
git commit -m "feat(ui): editable workspace path in OverviewTab"
```

---

### Task 6: `CodingAgentBanner` component

**Files:**
- Create: `apps/desktop-ui/src/chat/CodingAgentBanner.tsx`
- Create: `apps/desktop-ui/src/chat/CodingAgentBanner.test.tsx`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { CodingAgentBanner } from "./CodingAgentBanner";

describe("CodingAgentBanner", () => {
  test("renders the workspace nudge copy", () => {
    render(<CodingAgentBanner agentId="coding-agent" onOpenAgentEdit={() => {}} />);
    expect(screen.getByText(/隔离工作区|workspace/i)).toBeTruthy();
  });

  test("clicking the action invokes onOpenAgentEdit with the agent id", () => {
    const onOpen = mock(() => {});
    render(<CodingAgentBanner agentId="coding-agent" onOpenAgentEdit={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /切换|edit|change/i }));
    expect(onOpen).toHaveBeenCalledWith("coding-agent");
  });

  test("dismiss button hides the banner", () => {
    render(<CodingAgentBanner agentId="coding-agent" onOpenAgentEdit={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss|关闭|×/i }));
    expect(screen.queryByText(/隔离工作区/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — RED**

```bash
bun test apps/desktop-ui/src/chat/CodingAgentBanner.test.tsx
```

- [ ] **Step 3: Implement the component**

```tsx
import { useState } from "react";

export interface CodingAgentBannerProps {
  agentId: string;
  onOpenAgentEdit: (agentId: string) => void;
}

/**
 * Surfaces a one-time nudge when Vulture Coding is still bound to the
 * private workspace. Per-session dismissal — once the user closes it,
 * we don't show it again until the page reloads. Once the user picks a
 * non-private workspace, the parent stops rendering this component
 * entirely (so dismiss state becomes irrelevant).
 */
export function CodingAgentBanner({ agentId, onOpenAgentEdit }: CodingAgentBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="coding-agent-banner" role="status">
      <span className="coding-agent-banner-text">
        Vulture Coding 还在隔离工作区里运行。点这里切换到你的项目目录 →
      </span>
      <div className="coding-agent-banner-actions">
        <button
          type="button"
          className="coding-agent-banner-action"
          onClick={() => onOpenAgentEdit(agentId)}
        >
          切换工作区
        </button>
        <button
          type="button"
          className="coding-agent-banner-dismiss"
          aria-label="dismiss"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
```

Add corresponding minimal CSS to `apps/desktop-ui/src/styles.css`:

```css
.coding-agent-banner {
  /* Match neighbour banner / status row styles. Look at e.g. the
     existing OnboardingCard or RecoveryCard for the right tokens. */
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--accent-soft);
  border-bottom: 1px solid var(--border);
  font-size: 0.875rem;
}
.coding-agent-banner-actions {
  display: flex;
  gap: 0.5rem;
}
.coding-agent-banner-action {
  /* Use the existing button class if there's a "subtle" variant. */
  padding: 0.25rem 0.5rem;
}
.coding-agent-banner-dismiss {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
}
```

(Match real CSS variable names by reading `apps/desktop-ui/src/styles.css` for an existing accent + border pattern. Keep it minimal; UX polish can come later.)

- [ ] **Step 4: Run — GREEN**

```bash
bun test apps/desktop-ui/src/chat/CodingAgentBanner.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add \
  apps/desktop-ui/src/chat/CodingAgentBanner.tsx \
  apps/desktop-ui/src/chat/CodingAgentBanner.test.tsx \
  apps/desktop-ui/src/styles.css
git commit -m "feat(ui): CodingAgentBanner component"
```

---

### Task 7: Render banner in `ChatView` with conditions

**Files:**
- Modify: `apps/desktop-ui/src/chat/ChatView.tsx`
- Modify: `apps/desktop-ui/src/chat/ChatView.test.tsx`

- [ ] **Step 1: Understand the agent prop shape in ChatView**

```bash
grep -n "interface ChatViewProps\|agents:\|selectedAgentId\|activeAgent" apps/desktop-ui/src/chat/ChatView.tsx | head -10
```

ChatView already has `agents: ReadonlyArray<{ id: string; name: string }>` (line 16) — that shape doesn't include `isPrivateWorkspace`. We need to widen the agents array OR pass a separate signal.

The simplest path is to widen the type:

```typescript
agents: ReadonlyArray<{ id: string; name: string; isPrivateWorkspace?: boolean }>;
```

This matches the protocol schema change from Task 3.

- [ ] **Step 2: Write the failing tests**

In `ChatView.test.tsx`:

```typescript
test("CodingAgentBanner appears when active agent is coding-agent on a private workspace", () => {
  render(
    <ChatView
      {...baseProps}                                      // existing fixture
      agents={[{ id: "coding-agent", name: "Vulture Coding", isPrivateWorkspace: true }]}
      selectedAgentId="coding-agent"
      onOpenAgentEdit={() => {}}
    />,
  );
  expect(screen.getByText(/隔离工作区/i)).toBeTruthy();
});

test("banner hidden when active agent is general (not coding-agent)", () => {
  render(
    <ChatView
      {...baseProps}
      agents={[
        { id: "local-work-agent", name: "Vulture", isPrivateWorkspace: true },
        { id: "coding-agent", name: "Vulture Coding", isPrivateWorkspace: true },
      ]}
      selectedAgentId="local-work-agent"
      onOpenAgentEdit={() => {}}
    />,
  );
  expect(screen.queryByText(/隔离工作区/i)).toBeNull();
});

test("banner hidden when coding-agent has a non-private workspace", () => {
  render(
    <ChatView
      {...baseProps}
      agents={[{ id: "coding-agent", name: "Vulture Coding", isPrivateWorkspace: false }]}
      selectedAgentId="coding-agent"
      onOpenAgentEdit={() => {}}
    />,
  );
  expect(screen.queryByText(/隔离工作区/i)).toBeNull();
});

test("clicking 切换工作区 button calls onOpenAgentEdit('coding-agent')", () => {
  const onOpen = mock(() => {});
  render(
    <ChatView
      {...baseProps}
      agents={[{ id: "coding-agent", name: "Vulture Coding", isPrivateWorkspace: true }]}
      selectedAgentId="coding-agent"
      onOpenAgentEdit={onOpen}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /切换/i }));
  expect(onOpen).toHaveBeenCalledWith("coding-agent");
});
```

- [ ] **Step 3: Run — RED**

```bash
bun test apps/desktop-ui/src/chat/ChatView.test.tsx
```

- [ ] **Step 4: Implement**

In `ChatView.tsx`:

1. Widen `ChatViewProps.agents` to include `isPrivateWorkspace?: boolean`.
2. Add `onOpenAgentEdit?: (agentId: string) => void` to the props.
3. Render the banner near the top of the chat area:

```tsx
import { CodingAgentBanner } from "./CodingAgentBanner";

// inside ChatView component, where activeAgent is computed (around line 60):
const showCodingBanner =
  activeAgent?.id === "coding-agent" &&
  activeAgent.isPrivateWorkspace === true &&
  props.onOpenAgentEdit !== undefined;

// Render the banner above the existing content. Look at the JSX
// structure for the right insertion point — likely right after the
// chat header.
{showCodingBanner && props.onOpenAgentEdit ? (
  <CodingAgentBanner
    agentId="coding-agent"
    onOpenAgentEdit={props.onOpenAgentEdit}
  />
) : null}
```

- [ ] **Step 5: Run — GREEN**

```bash
bun test apps/desktop-ui/src/chat/ChatView.test.tsx
```

- [ ] **Step 6: Typecheck**

```bash
cd apps/desktop-ui && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add apps/desktop-ui/src/chat/ChatView.tsx apps/desktop-ui/src/chat/ChatView.test.tsx
git commit -m "feat(ui): render CodingAgentBanner in ChatView when conditions met"
```

---

### Task 8: Wire the banner click into the App-level modal opener

**Files:**
- Modify: `apps/desktop-ui/src/chat/AgentsPage.tsx` (or wherever the modal-opening state lives — probably `App.tsx`).
- Modify: the parent that owns ChatView, to pass the `onOpenAgentEdit` callback down.

- [ ] **Step 1: Find the existing modal-open code path**

```bash
grep -rn "AgentEditModal\|setSelectedAgent\|openAgentEdit" apps/desktop-ui/src --include="*.tsx" | grep -v test | head -20
```

Identify where `selectedAgent` (the agent currently being edited in the modal) is set. The banner click needs to reuse that same flow: set selectedAgent to coding-agent, pass `initialTab="overview"`, open the modal.

- [ ] **Step 2: Add a handler at the right level**

Wherever `selectedAgent` lives (likely in App.tsx or a high-level container):

```typescript
const [editTarget, setEditTarget] = useState<{ agent: Agent | null; tab: AgentsTab } | null>(null);

function openAgentEdit(agentId: string, tab: AgentsTab = "overview") {
  const agent = agents.find((a) => a.id === agentId) ?? null;
  setEditTarget({ agent, tab });
}

// Pass `onOpenAgentEdit={(id) => openAgentEdit(id, "overview")}` down to ChatView.
// Use editTarget to drive the AgentEditModal's `open` / `agent` / `initialTab` props.
```

If the existing flow already has a single source of truth for "open the modal for agent X", just add the `tab` plumbing.

- [ ] **Step 3: Manual smoke test**

```bash
cd apps/desktop-shell && cargo tauri dev
```

- Switch to coding-agent in the chat header.
- Verify the banner appears.
- Click "切换工作区" — modal opens on the Overview tab.
- Edit the workspace path to a real project directory; save.
- Banner should disappear after the save round-trip.

If the gateway dev server isn't running, the banner appears but workspace state won't refresh — that's an integration concern, not a banner bug.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-ui/src/chat/AgentsPage.tsx [other-touched-files]
git commit -m "feat(ui): wire CodingAgentBanner click → AgentEditModal"
```

(`-am` is forbidden — list files explicitly.)

---

## Phase 3 — Final verification

### Task 9: Full sweep + cross-package typecheck

**Files:** none.

- [ ] **Step 1: Full gateway suite**

```bash
cd apps/gateway && bun test
```

Expected: all tests pass (existing + new from Tasks 1, 2, 3).

- [ ] **Step 2: Full UI suite**

```bash
cd apps/desktop-ui && bun test
```

Expected: all tests pass.

- [ ] **Step 3: Protocol suite (in case schema changed for Task 3)**

```bash
cd packages/protocol && bun test
```

If the OpenAPI artifact test fails, regenerate:

```bash
cd packages/protocol && bun run openapi
git add packages/protocol/openapi/v1.json
git commit -m "chore(protocol): regenerate OpenAPI artifact for isPrivateWorkspace"
```

- [ ] **Step 4: Typecheck both packages**

```bash
cd apps/gateway && bun run typecheck
cd apps/desktop-ui && bun run typecheck
cd packages/protocol && bun run typecheck
```

- [ ] **Step 5: Manual end-to-end smoke**

```bash
cd apps/desktop-shell && cargo tauri dev
```

Acceptance:
1. **Fresh profile**: app opens, list shows Vulture (avatar = compass) and Vulture Coding (avatar = circuit). Vulture is selected by default.
2. Switch to Vulture Coding: banner appears at the top of ChatView with the Chinese copy.
3. Click "切换工作区": AgentEditModal opens on the Overview tab. Workspace input is editable and shows the private path.
4. Edit the workspace path to a real directory (e.g., `/Users/<you>/Code/some-repo`); save.
5. Banner disappears.
6. Reload the app. Both presets persist (Vulture, Vulture Coding). The custom workspace persists. Banner does NOT reappear for coding-agent.
7. Open a Rust file or TS file in the new workspace and ask the coding agent to use `lsp.diagnostics` — confirm the LSP path works against the user's real project. (Sanity check the foundation integration; not a hard pass criterion since LSP server availability depends on local setup.)

If any step fails, file a follow-up task and do not declare the plan complete.

- [ ] **Step 6: Confirm spec coverage**

Cross-check the spec one last time:
- §1 seed model — Tasks 1, 2 ✓
- §2 instructions + agent-core files — Tasks 1, 2 ✓
- §3 avatar — Task 1 (preset config) ✓
- §4 reasoning level — Task 1 ✓
- §5 workspace — Task 5 (editable input) ✓
- §6 banner — Tasks 6, 7, 8 ✓
- §7 delete behaviour — Task 1 (no special guard added) ✓

No commit for Task 9 unless the OpenAPI regen ran (Step 3).

---

## Self-Review Notes

Spec coverage checked above (Task 9 Step 6).

Type consistency:
- `AgentsTab` — defined in `AgentEditModal.tsx`; reused by Task 4 / Task 8. Same name throughout.
- `Agent.isPrivateWorkspace` — added in protocol (Task 3 Step 6); consumed in `ChatView` (Task 7) and read by `OverviewTab` indirectly (the workspace input doesn't depend on it).
- `onOpenAgentEdit` — function signature `(agentId: string) => void`. Same shape on `CodingAgentBannerProps` (Task 6) and `ChatViewProps` (Task 7); the App-level handler in Task 8 satisfies it.

Placeholder scan: no TBDs / TODOs / "implement later". All steps contain runnable code or exact commands.

Risks the plan does NOT cover (acknowledged tech debt):
- The OverviewTab workspace input is plain text, not a folder picker. Pasting paths is functional but feels primitive. Folder picker via `@tauri-apps/plugin-dialog` is a follow-up.
- `ensurePresetFieldsCurrent()` force-overwrites preset fields including `instructions`. Acceptable in dev (per Confirmed Decision #5 + spec risks); before public release we should swap to "overwrite only when value matches a known prior default."
- Banner dismiss state is per-session in component memory. If the user refreshes mid-session, the banner returns even if dismissed — acceptable since once they pick a real workspace, the banner stops rendering altogether.
