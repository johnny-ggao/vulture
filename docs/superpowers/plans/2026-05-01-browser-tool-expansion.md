# Browser Tool Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `browser.input`, `browser.scroll`, and `browser.extract` on top of the existing browser relay.

**Architecture:** Gateway tool specs declare approval-required browser tools. Rust callback routing forwards every `browser.*` action to the paired extension. The extension active-tab dispatcher sends DOM actions to the content script.

**Tech Stack:** TypeScript, Bun tests, Rust/Tokio tests, Chrome MV3 extension JavaScript.

---

### Task 1: Gateway Tool Registry

**Files:**
- Modify: `apps/gateway/src/tools/coreTools.ts`
- Modify: `apps/gateway/src/tools/sdkAdapter.test.ts`
- Modify: `apps/gateway/src/harness/toolContractHarness.ts`
- Modify: `apps/gateway/src/runtime/autoApprovalReviewer.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/v1/agent.ts`
- Modify: `apps/desktop-ui/src/api/agents.ts`
- Modify: `apps/desktop-ui/src/api/tools.ts`
- Modify: `apps/desktop-ui/src/chat/ToolGroupSelector.test.tsx`

- [x] Write failing gateway/UI tests for the new browser tools.
- [x] Add tool specs, protocol names, presets, fallback catalog, and contract harness fixtures.
- [x] Verify focused gateway/UI tests pass.

### Task 2: Rust Browser Relay

**Files:**
- Modify: `apps/desktop-shell/src/tool_callback/mod.rs`

- [x] Write failing Rust callback test proving `browser.input` is forwarded to the extension.
- [x] Generalize callback routing from two hard-coded browser tools to every `browser.*` tool.
- [x] Verify desktop-shell Rust tests pass.

### Task 3: Chrome Extension Dispatcher

**Files:**
- Modify: `extensions/browser/src/relay-client.js`
- Modify: `extensions/browser/src/content.js`
- Modify: `extensions/browser/README.md`

- [x] Add extension-side tests or focused module checks for dispatch coverage where available.
- [x] Implement active-tab dispatch for input, scroll, and extract.
- [x] Update extension README.

### Task 4: Verification

- [x] Run focused gateway and desktop UI tests.
- [x] Run Rust desktop-shell tests for browser relay.
- [x] Run `bun --filter '*' typecheck`.
- [x] Run `git diff --check`.
