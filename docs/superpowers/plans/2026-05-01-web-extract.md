# Web Extract Tool Implementation Plan

**Goal:** Add `web_extract` as a structured page extraction tool on top of the
existing Web Access Service.

### Task 1: Service Contract

- [x] Add failing service tests for HTML extraction and plain-text truncation.
- [x] Implement `WebAccessService.extract()`.
- [x] Keep public/private URL policy aligned with `web_fetch`.

### Task 2: Tool Wiring

- [x] Add `web_extract` to gateway local tools.
- [x] Add `web_extract` to the core tool registry with safe/idempotent metadata.
- [x] Add SDK approval/idempotency tests.

### Task 3: Product Synchronization

- [x] Add `web_extract` to protocol tool names and presets.
- [x] Add `web_extract` to desktop tool presets, capability groups, and fallback catalog.
- [x] Add `web_extract` to the tool contract harness.
- [x] Update default agent tool guidance.

### Task 4: Verification

- [x] Run focused service/tool/protocol/UI tests.
- [x] Run full typecheck.
- [x] Run diff whitespace check.
