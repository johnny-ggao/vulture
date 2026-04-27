# L1 — Run Persistence and Recovery

> Follow-up to Phase 3b/3c. Phase 3b introduced SSE runs, approvals, and basic startup sweep. Phase 3c added ChatGPT subscription auth. This design replaces the startup sweep with conservative recovery for all queued/running runs, using OpenAI Agents SDK `RunState` as the durable execution state wherever possible.

**Status:** Approved direction (brainstorm → spec). Implementation plan to follow.

**Companion plan:** `docs/superpowers/plans/2026-04-27-run-recovery.md` (to be written next).

---

## Goal

When the gateway restarts while a run is in flight, Vulture should preserve enough state to either continue the run or present a clear recovery decision to the user.

The design has three goals:

1. Do not lose in-flight work when the gateway process restarts.
2. Do not automatically repeat shell/browser tools whose side effects may already have happened.
3. Keep execution aligned with OpenAI Agents SDK: persist SDK `RunState`, resume with `Runner.run(agent, state, { stream: true })`, and use SDK approval/interruption semantics rather than inventing a parallel agent loop.

---

## Scope

| Item | In | Out |
|---|---|---|
| Add recoverable run status | ✅ | — |
| Persist run recovery metadata and SDK `RunState` string | ✅ | — |
| Restore all queued/running runs on gateway startup into a resumable/recoverable state | ✅ | — |
| Resume model-only interrupted runs from the latest SDK checkpoint | ✅ | — |
| Preserve and resume SDK human-in-the-loop approval interruptions | ✅ | — |
| Detect in-flight tool calls that lack `tool.completed` / `tool.failed` | ✅ | — |
| Require explicit user confirmation before retrying incomplete tools | ✅ | — |
| UI affordance for recoverable runs: continue / cancel | ✅ | — |
| Idempotency/audit events for recovery and tool retry | ✅ | — |
| Fully automatic replay of incomplete shell/browser tools | — | ❌ too risky |
| Recover after OS reboot while the desktop shell is unavailable | — | ❌ run remains recoverable until shell is available |
| Exact restoration of already-streamed partial text with no visual boundary | — | ❌ UI marks recovery boundary |
| Cross-version SDK state migration beyond one incompatible-state failure path | — | ❌ separate hardening project |

---

## Design Decisions

| Question | Decision |
|---|---|
| Recovery scope | Recover all queued/running runs, not just approval-interrupted runs. |
| Tool crash semantics | Conservative recovery: never auto-replay a tool call that was started but did not persist a terminal event. |
| User confirmation | Runs with incomplete tools become `recoverable`; user clicks continue to retry the missing tool. |
| SDK state source of truth | Persist `RunState.toString()` and restore with `RunState.fromStringWithContext(initialAgent, str, context)`. |
| Partial streamed text | Keep existing events immutable; append a recovery boundary event so UI can separate pre-crash draft text from resumed output. |
| Unrecoverable state | Mark failed with a specific error code only when the SDK state or required metadata is missing/corrupt. |

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Gateway startup                                                      │
│                                                                      │
│  RunStore.listRecoverableCandidates()                                │
│    status IN ('queued', 'running')                                   │
│          │                                                           │
│          ▼                                                           │
│  RecoveryService.classify(run)                                       │
│    ├─ no recovery metadata      → failed                             │
│    ├─ active tool incomplete    → recoverable                        │
│    ├─ approval interruption     → recoverable                        │
│    └─ model-only checkpoint     → queued for auto resume             │
│                                                                      │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Resume path                                                          │
│                                                                      │
│  POST /v1/runs/:rid/resume                                           │
│    or startup auto-resume for model-only runs                        │
│          │                                                           │
│          ▼                                                           │
│  orchestrateRecoveredRun(...)                                        │
│    ├─ rebuild Agent with same prompt/model/tools                     │
│    ├─ restore RunContext with Vulture tool callback                  │
│    ├─ RunState.fromStringWithContext(agent, sdkState, context)       │
│    ├─ Runner.run(agent, restoredState, { stream: true })             │
│    └─ continue normal event projection                               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Vulture keeps its own persistence layer because the product needs local UI events, run status, and tool audit boundaries. The actual agent continuation state remains SDK-owned.

---

## Data Model

### Run status

`packages/protocol/src/v1/run.ts`

Add:

```ts
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "recoverable",
  "succeeded",
  "failed",
  "cancelled",
]);
```

`recoverable` means the run is not executing, has durable state, and needs user action before continuing or cancelling.

### Recovery events

Add event variants:

```ts
{
  type: "run.recoverable";
  reason: "gateway_restarted" | "incomplete_tool" | "approval_pending";
  message: string;
}

{
  type: "run.recovered";
  mode: "auto" | "manual";
  discardPriorDraft: boolean;
}

{
  type: "tool.retrying";
  callId: string;
  tool: string;
  input: unknown;
}
```

`discardPriorDraft` tells the UI that pre-recovery streamed text should be visually separated from new output. The old events stay in the database for audit/debugging.

### Migration 003

Create `apps/gateway/src/persistence/migrations/003_run_recovery.sql`.

```sql
CREATE TABLE IF NOT EXISTS run_recovery_state (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  sdk_state TEXT,
  metadata_json TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL,
  active_tool_json TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO schema_version(version, applied_at)
VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
```

`metadata_json` contains the stable run reconstruction inputs:

```ts
type RunRecoveryMetadata = {
  runId: string;
  conversationId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  userInput: string;
  workspacePath: string;
  providerKind: "codex" | "api_key" | "stub";
  updatedAt: string;
};
```

`active_tool_json` is either null or:

```ts
type ActiveToolRecovery = {
  callId: string;
  tool: string;
  input: unknown;
  approvalToken?: string;
  startedSeq: number;
};
```

---

## Runtime Flow

### Normal run checkpointing

`runOrchestrator` creates recovery metadata before marking the run running. `openaiLlm` emits checkpoint callbacks when the SDK stream reaches a durable state.

Durable checkpoints are:

1. Before the first SDK model call, with initial run metadata.
2. After `Runner.run(...)` returns an SDK `StreamedRunResult` with a changed `RunState`.
3. When the SDK reports interruptions.
4. After every terminal tool event.

The checkpoint callback stores:

```ts
{
  sdkState: stream.state.toString(),
  checkpointSeq: runs.latestSeq(runId),
  activeTool: null
}
```

When a tool starts, the tool bridge stores `activeTool`. When `tool.completed` or `tool.failed` is persisted, it clears `activeTool`.

### Startup recovery classification

On gateway startup:

1. Read all runs with status `queued` or `running`.
2. If no `run_recovery_state` exists, mark failed with `internal.recovery_state_unavailable`.
3. If `active_tool_json` is present and no terminal event exists for that callId, mark `recoverable` and append `run.recoverable` with reason `incomplete_tool`.
4. If SDK state contains an approval interruption, mark `recoverable` and append `run.recoverable` with reason `approval_pending`.
5. Otherwise mark queued and schedule auto-resume. Append `run.recovered` with `mode: "auto"` and `discardPriorDraft: true`.

Queued auto-resume runs use the same orchestrator path as manual resume, but without retrying any incomplete tool.

Recovered runs do not emit a second `run.started`. They append `run.recovered`, then continue with new text/tool events. The original `run.started` remains the lifecycle start event for that run.

### Manual resume

Add `POST /v1/runs/:rid/resume`.

Rules:

- `404` if run does not exist.
- `409` if run is not `recoverable`.
- `409` if another process already started the run.
- `202` when resume is scheduled.

If `activeTool` exists, the first action after resume is to append `tool.retrying`, set the active tool as SDK-approved only for that callId if the previous recovery state carried an approval token, and continue from the SDK state. The tool is retried only after this explicit user request.

### Cancel recoverable

Existing `POST /v1/runs/:rid/cancel` accepts `recoverable` runs. It marks cancelled and appends `run.cancelled`; no SDK resume is attempted.

---

## UI Flow

Conversation list should treat `recoverable` as active enough to surface the conversation near the top.

In the chat view:

- Show a compact recovery card at the latest `run.recoverable` event.
- Buttons: `继续` and `取消`.
- `继续` calls `POST /v1/runs/:rid/resume`.
- `取消` calls existing cancel endpoint.
- If `run.recovered.discardPriorDraft` arrives, the event renderer marks earlier draft text as "重启前草稿" and starts a fresh assistant stream after the boundary.

The UI does not need to understand SDK internals.

---

## Error Handling

| Failure | Result |
|---|---|
| Missing recovery row | `failed`, code `internal.recovery_state_unavailable` |
| SDK `RunState.fromStringWithContext` fails | `failed`, code `internal.recovery_state_invalid` |
| Provider credentials unavailable on resume | `recoverable`, append `run.recoverable` with message asking user to re-authenticate |
| Shell callback unavailable | `recoverable`, no tool retry until user resumes again |
| User cancels recoverable run | `cancelled` |
| Tool retry denied by policy/user | normal `tool.failed`; SDK receives rejection/output and may adapt |

---

## OpenAI Agents SDK Alignment

Implementation must prefer SDK primitives:

- Use `OpenAIProvider` per run, not global SDK client mutation.
- Use `Runner.run(agent, inputOrRunState, { stream: true, context })`.
- Serialize SDK state with `RunState.toString()`.
- Rehydrate with `RunState.fromStringWithContext(...)` so Vulture can restore the local `ToolCallable`, approval handler, runId, and workspacePath.
- Use SDK interruptions and `state.approve(...)` / `state.reject(...)` for approvals.
- Keep Vulture-specific code as an adapter: event projection, local policy, audit, recovery classification, and UI status.

---

## Testing Strategy

### Gateway unit tests

- Migration 003 creates `run_recovery_state`.
- `RunStore` can save, load, clear, and classify recovery state.
- `recoverInflightOnStartup` no longer blindly fails every active run.
- Incomplete active tool becomes `recoverable`.
- Model-only active run is scheduled for auto-resume.
- Corrupt SDK state marks failed with `internal.recovery_state_invalid`.

### Runtime tests

- `openaiLlm` calls checkpoint hooks with SDK state strings.
- Rehydrated SDK state flows into `Runner.run(agent, state, { stream: true })`.
- SDK approval interruption survives recovery and resumes after approval.
- Active tool retry is not executed until `/resume` is called.

### Route tests

- `POST /v1/runs/:rid/resume` returns `202` for recoverable runs.
- Resume on succeeded/failed/cancelled returns `409`.
- Cancel works for recoverable runs.
- SSE reconnect replays `run.recoverable` and `run.recovered`.

### UI tests

- Recoverable event renders a recovery card.
- Continue calls resume endpoint.
- Cancel calls cancel endpoint.
- Recovery boundary separates pre-restart draft text from resumed output.

---

## Rollout

This is a schema-changing feature, so it ships behind the new protocol status/events and migration 003. Existing completed runs are unaffected. Existing queued/running runs from older database versions that lack recovery rows are marked failed once with `internal.recovery_state_unavailable`.

Manual validation should cover:

1. Start a model-only run, kill gateway, restart, verify auto-resume.
2. Start a run that asks approval, kill gateway, restart, verify recoverable card and continue.
3. Start a run that begins a shell tool, kill gateway before completion, restart, verify no automatic replay and manual continue retries.
4. Cancel a recoverable run.
5. Reconnect SSE after recovery and verify events replay cleanly.
