# Web Access Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inline `web_search` and `web_fetch` implementation with a model-independent gateway Web Access Service.

**Architecture:** Create `apps/gateway/src/runtime/webAccess.ts` for search provider abstraction, URL classification, fetch timeout, and output shaping. Wire `gatewayLocalTools` to the service while preserving existing tool names and outputs.

**Tech Stack:** Bun test runner, TypeScript, existing `ToolCallError`, injectable `fetch` function.

---

### Task 1: Web Access Service

**Files:**
- Create: `apps/gateway/src/runtime/webAccess.ts`
- Test: `apps/gateway/src/runtime/webAccess.test.ts`

- [x] Write failing tests for public/private URL classification, DuckDuckGo search parsing, fetch truncation, and fetch timeout.
- [x] Implement `createWebAccessService`, `DuckDuckGoHtmlSearchProvider`, and URL classification.
- [x] Run `bun test apps/gateway/src/runtime/webAccess.test.ts`.

### Task 2: Gateway Tool Integration

**Files:**
- Modify: `apps/gateway/src/runtime/gatewayLocalTools.ts`
- Test: `apps/gateway/src/runtime/gatewayLocalTools.test.ts`

- [x] Write failing integration tests proving public `web_search` and public `web_fetch` run without approval in workspace-scoped mode.
- [x] Write a failing test proving private `web_fetch` still requires approval.
- [x] Replace inline web implementation with `WebAccessService`.
- [x] Run `bun test apps/gateway/src/runtime/gatewayLocalTools.test.ts`.

### Task 3: Tool Contract Regression

**Files:**
- Modify only if a test exposes a contract drift.

- [x] Run focused runtime/tool tests for web tools and SDK adapter behavior.
- [x] Run gateway typecheck or the repo's relevant typecheck command.
- [x] Run `git diff --check`.
