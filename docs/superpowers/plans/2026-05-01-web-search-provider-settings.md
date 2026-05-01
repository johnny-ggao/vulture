# Web Search Provider Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure Vulture's model-independent `web_search` provider from Settings.

**Architecture:** Store profile-level settings in a JSON file, expose gateway routes for settings/test, add SearXNG support to `WebAccessService`, and add a Settings "联网" section that calls those routes.

**Tech Stack:** TypeScript, Bun tests, Hono routes, React Testing Library.

---

### Task 1: Gateway Store And Routes

**Files:**
- Create: `apps/gateway/src/domain/webSearchSettingsStore.ts`
- Create: `apps/gateway/src/domain/webSearchSettingsStore.test.ts`
- Create: `apps/gateway/src/routes/webSearchSettings.ts`
- Create: `apps/gateway/src/routes/webSearchSettings.test.ts`
- Modify: `apps/gateway/src/server/stores.ts`
- Modify: `apps/gateway/src/server/routes.ts`

- [x] Write failing store tests for default settings, patch persistence, and invalid SearXNG URL rejection.
- [x] Implement the JSON store.
- [x] Write failing route tests for GET, PATCH, and POST test.
- [x] Implement the Hono router and mount it.

### Task 2: Runtime Provider Selection

**Files:**
- Modify: `apps/gateway/src/runtime/webAccess.ts`
- Modify: `apps/gateway/src/runtime/webAccess.test.ts`
- Modify: `apps/gateway/src/server/localTools.ts`
- Modify: `apps/gateway/src/server/localTools.test.ts`

- [x] Write failing tests for SearXNG JSON parsing and configured provider resolution.
- [x] Implement `SearxngSearchProvider`.
- [x] Wire `createGatewayServerLocalTools` to build a `WebAccessService` from the settings store.

### Task 3: Desktop Settings UI

**Files:**
- Create: `apps/desktop-ui/src/api/webSearchSettings.ts`
- Create: `apps/desktop-ui/src/chat/Settings/WebSearchSection.tsx`
- Modify: `apps/desktop-ui/src/chat/Settings/SettingsPage.tsx`
- Modify: `apps/desktop-ui/src/chat/Settings/types.ts`
- Modify: `apps/desktop-ui/src/App.tsx`
- Modify: `apps/desktop-ui/src/chat/SettingsPage.test.tsx`

- [x] Write failing UI test for loading settings, changing SearXNG URL, testing, and saving.
- [x] Implement API client functions.
- [x] Implement the Settings section and wire App callbacks.

### Task 4: Verification

- [x] Run focused gateway and desktop tests.
- [x] Run `bun --filter '*' typecheck`.
- [x] Run `git diff --check`.
