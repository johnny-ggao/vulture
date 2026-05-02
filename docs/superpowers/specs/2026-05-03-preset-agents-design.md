# Preset Agents Design

Date: 2026-05-03

## Goal

Replace the single seeded `local-work-agent` with two preset agents that ship out of the box:

- **Vulture** — a general-purpose assistant for day-to-day work (writing, research, Q&A, file ops).
- **Vulture Coding** — an engineering counterpart that runs inside a code repository, with discipline around verification, TDD, and small focused changes.

Both presets are seeded by `AgentStore` on startup and reconciled on every gateway boot. They live alongside any user-created agents.

## Context

Today `apps/gateway/src/domain/agentStore.ts` exports a single `DEFAULT_AGENT` constant and an `ensureDefault()` private method. Every read/write entry point (`list`, `get`, `save`, `delete`) calls `ensureDefault()` first, which `INSERT OR REPLACE`s the canonical row. Workspace, instructions, and `agent-core/` files are reconciled per-call.

Skills are file-based: discovered at runtime from `profile/skills`, `workspace/skills`, and `agent-core/skills`. The `agent.skills` field is an allowlist; `undefined` means "all discovered skills available." We rely on this — neither preset hard-codes a skill list.

The project is in development. There are no production users; we do not need to write reconciliation code that protects legacy field values. Forced overwrite of DB-stored fields is acceptable.

## Confirmed Decisions

1. **Replacement, not coexistence.** The existing `local-work-agent` row evolves in place into "Vulture"; ID stays the same so existing local conversations keep their foreign key. A second preset, `coding-agent`, is added.
2. **Light-to-medium differentiation.** Both presets share `model = gpt-5.4` and `toolPreset = full`. The coding agent uses `reasoning = high`; the general agent stays at `medium`. No tool restrictions, no preset skills allowlist, no preset handoffs.
3. **No preset handoffs.** `handoffAgentIds = []` for both. The user can later compose a "team" by adding handoff edges in `HandoffTab`.
4. **Workspace defaults to private.** Both presets fall back to `createPrivateWorkspace()`. The coding agent does *not* auto-bind to any real repo at seed time; the UI (see §6) nudges the user to swap to their project on first use.
5. **Forced overwrite of DB fields, existence-only for files.** Each `ensureDefaults()` pass rewrites the preset rows' `name / description / instructions / model / reasoning / tool_preset / tool_include / tool_exclude / tools / skills / handoff_agent_ids / avatar`. Workspace is preserved if the user has changed it (existing reconciliation logic stays). `agent-core/USER.md` and `agent-core/IDENTITY.md` are seeded only when the file does not exist.
6. **Language preference lives in `agent-core/USER.md`, not in `instructions`.** Default: 中文 unless the user writes in English. This keeps `instructions` neutral and lets per-agent localization live in user-editable files.
7. **Delete is allowed; presets self-heal.** If the user deletes either preset, the next `ensureDefaults()` call recreates it. No special "preset is undeletable" guard.

## Design

### §1 — Seed model

In `apps/gateway/src/domain/agentStore.ts`:

- Replace `const DEFAULT_AGENT: SaveAgentRequest` with `const DEFAULT_AGENTS: readonly SaveAgentRequest[]`.
- Rename `ensureDefault()` → `ensureDefaults()`. Iterate `DEFAULT_AGENTS` and run the existing reconcile path for each (`INSERT OR REPLACE` semantics on the row + `ensureAgentCoreFilesForValues` + `ensureDefaultWorkspaceCurrent`).
- Update all four call sites (`list`, `get`, `save`, `delete`) to call the renamed method.
- `ensureDefaultToolsCurrent()` and `ensureDefaultWorkspaceCurrent()` extend to iterate over both preset IDs.

The two preset definitions:

```ts
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

const DEFAULT_AGENTS = [PRESET_GENERAL, PRESET_CODING] as const;
```

`profileStore.ts`'s `DEFAULT_ACTIVE_AGENT = "local-work-agent"` stays — Vulture (general) is still the active agent on first launch.

### §2 — Instructions and agent-core files

`PRESET_GENERAL_INSTRUCTIONS` (English, neutral, no language preference):

```
You are Vulture, a local-first general assistant.
Complete the user's task directly; do not stall with standby phrases.
Inspect files and run tools to ground your answers — never claim a local action ran unless a tool result confirms it.
For workspace questions, read the directory before summarizing.
When the user is exploring an idea, ask focused clarifying questions before committing to an answer.
```

`PRESET_CODING_INSTRUCTIONS`:

```
You are Vulture Coding, an engineering partner working inside a code repository.
Always read before editing; never invent APIs, file paths, or function signatures — confirm with the read or search tools first.
Prefer small, focused changes over sweeping rewrites; respect existing patterns in the repo.
Verify your work with builds, tests, or type-checks before claiming a change is complete.
When fixing bugs, find the root cause; do not paper over symptoms.
For risky operations (destructive shell, dependency changes, force pushes), surface the plan before executing.
```

`agent-core/` files are seeded by an extension to `ensureAgentCoreFilesForValues`:

For both presets, `agent-core/USER.md` (only if missing):

```
# User Preferences

- Default language: 中文 (Chinese). Switch to English only when the user writes in English.
- Style: concise, no filler greetings, no trailing summaries when the diff or output already speaks for itself.
```

For `coding-agent` only, `agent-core/IDENTITY.md` (only if missing):

```
# Identity

You are Vulture Coding, the engineering counterpart of Vulture.

Working principles:
- Test-driven when feasible: write the failing test first, then the implementation.
- Small files, small functions; high cohesion, low coupling.
- Immutable data flow; no in-place mutation of arguments.
- Validate inputs at boundaries; trust internal contracts.
- When in doubt, read the code rather than guess.
```

The "only if missing" check uses `existsSync` on the resolved path under `agentCorePath(id)`. No reconciliation of contents — once the file exists, the user owns it.

### §3 — Avatar

Avatar values are preset keys from `AVATAR_PRESETS` in `apps/desktop-ui/src/chat/components/agentAvatarPresets.tsx`:

- General: `avatar: "compass"` (blue background, navigation glyph — broad-purpose feel)
- Coding: `avatar: "circuit"` (purple background, circuit glyph — only preset that maps directly to engineering)

Stored as plain strings in the DB; no UI-layer changes needed beyond the seeded values.

### §4 — Reasoning level

`reasoning` is the only capability field that differs:

- General: `medium` (preserves current behavior)
- Coding: `high`

`gpt-5.4` accepts both. No protocol change required.

### §5 — Workspace handling

`ensureAgentWorkspace()` keeps its current contract: if the agent already has a valid workspace, leave it; otherwise call `createPrivateWorkspace()`. Both preset IDs participate in this flow unchanged.

For `coding-agent`, `createPrivateWorkspace()` produces a path under `<profile>/agents/coding-agent/project/`. This is technically valid but semantically wrong as a long-term home for engineering work. We address this in the UI (§6), not in the data model.

### §6 — Coding-agent first-use UI nudge

A new dismissible banner in `ChatView.tsx`, shown when **all** of the following are true:

1. `conversation.agentId === "coding-agent"`.
2. The agent's `workspace.path` resolves to a path inside its private workspace root (computed via the existing `agentRootPath()` helper, the same logic `isManagedPrivateWorkspace` uses today).
3. The user has not dismissed the banner for this agent in this session.

Banner copy:

```
Vulture Coding 还在隔离工作区里运行。点击切换到你的项目目录 →
```

Click action: open `AgentEditModal` for `coding-agent` on the **CoreTab** with the workspace selector focused (extend the modal's open API with a `focus?: "workspace"` hint, or pass through the existing tab routing).

Dismissal is per-session (in-memory state on `ChatView`). Once the user picks a non-private workspace, condition (2) becomes false and the banner stops appearing on subsequent loads — no persistence needed.

### §7 — Delete behaviour

`AgentStore.delete(id)` keeps its current "cannot delete the last agent" guard. No new guard for preset IDs. If a user deletes `coding-agent`, the next `ensureDefaults()` re-inserts it on the next gateway start (or sooner — every `list/get/save/delete` triggers `ensureDefaults()`). Practical effect: deleting a preset effectively resets it.

This is consistent with the existing self-healing model and avoids a special "you cannot delete this" UX corner.

## Out of Scope

- Bundling default skill `.md` files into the app. Skills remain user-managed.
- Adding a preset team / handoff graph. The user manually composes teams later.
- Migrating production data — there is none.
- Localized strings for the banner / instructions beyond the Chinese banner copy. English variants can be added when i18n lands.
- New schema fields (e.g. `requiresWorkspaceSelection: true`). UI gating is sufficient.

## Files Touched

- `apps/gateway/src/domain/agentStore.ts` — seed array, rename `ensureDefault → ensureDefaults`, extend `ensureDefaultToolsCurrent` / `ensureDefaultWorkspaceCurrent` / `ensureAgentCoreFilesForValues` to iterate or accept per-preset core file content.
- `apps/desktop-ui/src/chat/ChatView.tsx` — banner component + private-workspace check.
- `apps/desktop-ui/src/chat/AgentEditModal.tsx` (or its open API surface) — accept a `focus?: "workspace"` hint to deep-link from the banner.
- `apps/gateway/src/domain/agentStore.test.ts` — tests for both presets being seeded, idempotent reconcile, USER.md/IDENTITY.md existence-only seeding, delete-then-list re-seeds, avatar/reasoning persistence.
- `apps/desktop-ui/src/chat/ChatView.test.tsx` — banner show/hide conditions and dismiss behaviour.

## Risks & Mitigations

- **`ensureDefaults()` runs on every store entry point, so per-call cost grows with preset count.** Today there are two presets; reconciliation reads two rows and writes only when contents diverge. If the array grows past ~10, we revisit by gating reconciliation behind a one-time-per-process flag.
- **Forced overwrite of `instructions` masks user edits to preset rows.** Acceptable in dev. Before first public release, swap to "overwrite only when value matches a known prior default" (the design we floated earlier as option C).
- **Banner relies on `isManagedPrivateWorkspace`-style path matching.** If the existing helper is private to `agentStore.ts`, we expose a small read-only API on the store (e.g. `isUsingPrivateWorkspace(id)`) and surface it via the gateway → UI bridge rather than duplicating path math in the React layer.
