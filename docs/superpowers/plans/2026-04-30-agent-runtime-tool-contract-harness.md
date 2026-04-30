# Agent Runtime Tool Contract Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build product-grade, deterministic harness lanes for agent runtime behavior and core tool contracts.

**Architecture:** Add two focused in-process harnesses under `apps/gateway/src/harness`: one drives scripted LLM scenarios through the agent runtime, and one validates the real core tool registry plus SDK adapter contract. Each harness has fixtures, a runner, CLI entrypoint, structured artifacts, and tests.

**Tech Stack:** Bun test, TypeScript, existing `@vulture/agent-runtime`, existing gateway core tool registry, existing artifact conventions.

---

### Task 1: Agent Runtime Harness

**Files:**
- Create: `apps/gateway/src/harness/runtimeHarness.ts`
- Create: `apps/gateway/src/harness/runtimeHarnessCli.ts`
- Create: `apps/gateway/src/harness/runtimeHarness.test.ts`

- [ ] Write failing tests for scripted text, tool success, tool failure, usage, checkpoint, recovery, and artifact output.
- [ ] Implement runtime fixtures as TypeScript scenarios with scripted LLM yields and expected observations.
- [ ] Implement runner that executes scenarios through `runConversation`, captures events/checkpoints/tool calls, writes `summary.json`, `events.jsonl`, `failure-report.md`, and returns a pass/fail summary.
- [ ] Implement CLI with `--list`, `--scenario`, and `--tag`.
- [ ] Run `bun test apps/gateway/src/harness/runtimeHarness.test.ts`.

### Task 2: Tool Contract Harness

**Files:**
- Create: `apps/gateway/src/harness/toolContractHarness.ts`
- Create: `apps/gateway/src/harness/toolContractHarnessCli.ts`
- Create: `apps/gateway/src/harness/toolContractHarness.test.ts`

- [ ] Write failing tests that scan `createCoreToolRegistry()` and validate uniqueness, metadata, schema fixtures, approval behavior, idempotency, and SDK adapter propagation.
- [ ] Implement per-tool fixtures for valid input, invalid input, expected approval, risk, category, and idempotency.
- [ ] Implement runner that validates all core tools and writes `summary.json`, `results.json`, and `failure-report.md`.
- [ ] Implement CLI with `--list`, `--tool`, and `--category`.
- [ ] Run `bun test apps/gateway/src/harness/toolContractHarness.test.ts`.

### Task 3: Scripts, CI, and Docs

**Files:**
- Modify: `apps/gateway/package.json`
- Modify: `package.json`
- Modify: `docs/harness/acceptance.md`

- [ ] Add `harness:runtime` and `harness:tools` scripts to the gateway package.
- [ ] Add root `harness:runtime` and `harness:tools` scripts.
- [ ] Include both lanes in root `harness:ci`.
- [ ] Document commands, artifact paths, deterministic constraints, and what each harness proves.
- [ ] Run `bun run harness:runtime`, `bun run harness:tools`, `bun run harness:ci`, and gateway typecheck.

### Task 4: Verification and Commit

**Files:**
- All files above.

- [ ] Run focused harness tests.
- [ ] Run full gateway harness tests.
- [ ] Run typecheck.
- [ ] Inspect `git diff`.
- [ ] Commit with `feat(harness): add runtime and tool contract lanes`.

