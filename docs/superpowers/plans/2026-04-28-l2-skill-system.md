# L2 Skill System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local `SKILL.md` capability-package system for Vulture agents.

**Architecture:** Implement a focused gateway-side skill runtime that discovers profile/workspace skills, filters them by agent allowlist and metadata, and renders an available-skills block for each run. Extend the protocol and agent store with optional `skills`, then append the rendered block to the run prompt passed into the existing Agents SDK path.

**Tech Stack:** TypeScript, Bun test, Zod 4, existing gateway `AgentStore`, existing `makeOpenAILlm` run factory.

---

### Task 1: Skill Runtime

**Files:**
- Create: `apps/gateway/src/runtime/skills.ts`
- Test: `apps/gateway/src/runtime/skills.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for valid load, workspace precedence, allowlist, empty allowlist, unsafe symlink, oversize skip, and prompt rendering.

- [ ] **Step 2: Run failing tests**

Run: `bun test apps/gateway/src/runtime/skills.test.ts`

Expected: fail because `./skills` module does not exist.

- [ ] **Step 3: Implement runtime**

Create `SkillEntry`, `loadSkillEntries`, `filterSkillEntries`, and `formatSkillsForPrompt`. Use realpath containment, reject symlinked `SKILL.md`, cap file size, skip hidden directories and `node_modules`, parse simple YAML front matter, parse `metadata.openclaw` JSON for `always`, `os`, and `requires.env`.

- [ ] **Step 4: Verify tests pass**

Run: `bun test apps/gateway/src/runtime/skills.test.ts`

Expected: pass.

### Task 2: Agent Protocol And Store

**Files:**
- Modify: `packages/protocol/src/v1/agent.ts`
- Modify: `apps/gateway/src/domain/agentStore.ts`
- Test: `apps/gateway/src/domain/agentStore.test.ts`

- [ ] **Step 1: Write failing tests**

Add protocol/store tests proving `skills` can be saved as `[]` and `["skill-name"]`, and older/default agents expose `skills: undefined`.

- [ ] **Step 2: Run failing tests**

Run: `bun test apps/gateway/src/domain/agentStore.test.ts packages/protocol/src/v1/agent.test.ts`

Expected: fail because `skills` is not accepted/persisted yet. If no agent protocol test file exists, run the store test only.

- [ ] **Step 3: Implement protocol/store support**

Add `skills?: string[]` to agent schema and save request. Persist it in a new nullable `skills` column or a backward-compatible JSON field if a suitable migration pattern exists. For existing rows, return `undefined`.

- [ ] **Step 4: Verify tests pass**

Run: `bun test apps/gateway/src/domain/agentStore.test.ts packages/protocol/src/v1`

Expected: pass.

### Task 3: Run Prompt Injection

**Files:**
- Modify: `apps/gateway/src/runtime/openaiLlm.ts`
- Modify: run creation path in `apps/gateway/src/routes/runs.ts` or caller that builds `systemPrompt`
- Test: `apps/gateway/src/runtime/openaiLlm.test.ts` and/or route integration tests

- [ ] **Step 1: Write failing test**

Add a test proving a configured workspace skill appears in the `systemPrompt` passed to `runFactory`, and an agent with `skills: []` does not receive the block.

- [ ] **Step 2: Run failing test**

Run: `bun test apps/gateway/src/runtime/openaiLlm.test.ts apps/gateway/src/routes/runs.test.ts`

Expected: fail because no skills block is appended.

- [ ] **Step 3: Implement injection**

Load skills using active agent workspace and profile dir before invoking the LLM. Append the rendered block to run context without mutating stored agent instructions.

- [ ] **Step 4: Verify targeted tests**

Run: `bun test apps/gateway/src/runtime/skills.test.ts apps/gateway/src/domain/agentStore.test.ts apps/gateway/src/runtime/openaiLlm.test.ts apps/gateway/src/routes/runs.test.ts`

Expected: pass.

### Task 4: Final Verification

**Files:**
- Existing modified files only.

- [ ] **Step 1: Typecheck gateway and protocol**

Run: `bun --filter @vulture/gateway typecheck && bun --filter @vulture/protocol typecheck`

Expected: pass.

- [ ] **Step 2: Run broader Bun tests**

Run: `bun test apps/gateway/src packages/protocol/src`

Expected: pass.

- [ ] **Step 3: Review diff**

Run: `git diff --stat && git diff --check`

Expected: no whitespace errors and only scoped files changed.
