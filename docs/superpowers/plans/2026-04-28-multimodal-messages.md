# Multimodal Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user image/file attachments to chat messages, persist them under the active profile, and pass them to the OpenAI Agents SDK adapters as multimodal input.

**Architecture:** Gateway owns attachment upload, blob storage, metadata, and message linking. Protocol/API types expose attachment metadata to UI. Runtime receives resolved attachment bytes only at run execution time and keeps OpenAI-specific content shape inside LLM adapters.

**Tech Stack:** Bun, Hono, SQLite migrations, React, TypeScript, OpenAI Agents JS adapters, local profile filesystem storage.

---

## File Structure

- `packages/protocol/src/v1/conversation.ts`: attachment schemas and `PostMessageRequestSchema.attachmentIds`.
- `packages/protocol/src/v1/conversation.test.ts`: protocol validation.
- `apps/gateway/src/persistence/migrations/005_message_attachments.sql`: `blobs` and `message_attachments`.
- `apps/gateway/src/persistence/migrate.ts`: register migration 005.
- `apps/gateway/src/domain/attachmentStore.ts`: upload metadata, content lookup, message linking, runtime attachment loading.
- `apps/gateway/src/domain/attachmentStore.test.ts`: attachment store tests.
- `apps/gateway/src/routes/attachments.ts`: upload and content routes.
- `apps/gateway/src/routes/attachments.test.ts`: route tests.
- `apps/gateway/src/domain/messageStore.ts`: return messages with attachments.
- `apps/gateway/src/routes/runs.ts`: accept `attachmentIds`, link to user message, pass runtime attachments.
- `apps/gateway/src/runtime/runOrchestrator.ts`: carry attachment metadata into `runConversation`.
- `packages/agent-runtime/src/runner.ts`: add `userAttachments` to LLM invocation.
- `apps/gateway/src/runtime/openaiLlm.ts` and `apps/gateway/src/runtime/codexLlm.ts`: map attachments to provider input content.
- `apps/desktop-ui/src/api/attachments.ts`: upload helper.
- `apps/desktop-ui/src/api/conversations.ts` and `apps/desktop-ui/src/api/runs.ts`: attachment DTOs and send request.
- `apps/desktop-ui/src/chat/Composer.tsx`: file picker, upload chips, send ids.
- `apps/desktop-ui/src/chat/MessageBubble.tsx`: attachment rendering.
- Tests near each changed unit.

## Tasks

### Task 1: Protocol and Migration

- [ ] Write failing protocol tests for message attachments and attachment id limit.
- [ ] Add `MessageAttachmentSchema`, `attachments`, and `attachmentIds`.
- [ ] Write failing migration test expecting `blobs` and `message_attachments`.
- [ ] Add migration 005 and register it.
- [ ] Run `bun test packages/protocol/src/v1/conversation.test.ts apps/gateway/src/persistence/migrate.test.ts`.

### Task 2: Attachment Store and Routes

- [ ] Write failing store tests for blob write, content lookup, message linking, missing/reused validation, and size limit.
- [ ] Implement `AttachmentStore` with profile-relative path resolution and SHA-256 storage.
- [ ] Write failing route tests for multipart upload and content fetch.
- [ ] Add `attachmentsRouter` and mount it in `server.ts`.
- [ ] Run `bun test apps/gateway/src/domain/attachmentStore.test.ts apps/gateway/src/routes/attachments.test.ts`.

### Task 3: Message and Run Integration

- [ ] Write failing message store test showing `listSince()` returns attachments.
- [ ] Extend `MessageStore` to join attachment metadata.
- [ ] Write failing runs route test for `{ input, attachmentIds }`.
- [ ] Link attachments to the user message before run creation.
- [ ] Persist attachment ids in recovery metadata and reload runtime attachments for run/resume.
- [ ] Run `bun test apps/gateway/src/domain/messageStore.test.ts apps/gateway/src/routes/runs.test.ts apps/gateway/src/runtime/runOrchestrator.test.ts`.

### Task 4: Runtime Adapter Mapping

- [ ] Write failing `runConversation()` test proving `userAttachments` reaches `LlmCallable`.
- [ ] Extend `LlmCallable`, `RunConversationArgs`, and orchestrator call sites.
- [ ] Write adapter tests for image/file mapping to SDK content arrays.
- [ ] Implement provider-local mapping and provider rejection errors.
- [ ] Run `bun test packages/agent-runtime/src/runner.test.ts apps/gateway/src/runtime/openaiLlm.test.ts apps/gateway/src/runtime/codexLlm.test.ts`.

### Task 5: UI Upload and Rendering

- [ ] Write failing Composer test for file selection, upload, remove, and send ids.
- [ ] Add `attachmentsApi.upload()` and Composer draft attachment state.
- [ ] Write failing MessageBubble test for image/file attachment display.
- [ ] Render persisted attachments in messages.
- [ ] Add App integration test for upload then send.
- [ ] Run `bun test apps/desktop-ui/src/chat/Composer.test.tsx apps/desktop-ui/src/chat/MessageBubble.test.tsx apps/desktop-ui/src/App.integration.test.tsx`.

### Task 6: Verification

- [ ] Run `bun --filter '*' typecheck`.
- [ ] Run focused gateway, runtime, and UI tests from Tasks 1-5.
- [ ] Run `git diff --check`.
- [ ] Commit implementation after tests pass.

## Coverage Check

- Storage: Tasks 1-2.
- API: Tasks 2-3.
- Runtime/Agents SDK mapping: Task 4.
- UI: Task 5.
- Recovery: Task 3.
- Error handling and limits: Tasks 1-3 and 5.
