# Subagent Productization Design

Date: 2026-05-02

## Goal

Productize Vulture's existing subagent orchestration so a user can see delegated
work progress and understand how child results are recovered into the parent
answer. This is the B + C slice: subagent execution visibility plus result
recovery. It should not become a full team-chat system or a heavyweight
multi-agent scheduler.

## References

- OpenAI Agents SDK TypeScript: [Agent Orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/)
- OpenAI Agents SDK TypeScript: [Tools](https://openai.github.io/openai-agents-js/guides/tools/)
- OpenAI Agents SDK TypeScript: [Handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/)
- Openclaw local reference: `openclaw/docs/tools/subagents.md`
- Accio local reference: `/Applications/Accio.app/Contents/Resources/app.asar`, extracted `subagent-session-store`

## Current State

Vulture already has the core substrate:

- Agent configuration supports `handoffAgentIds`.
- The assembled prompt tells the parent agent to decide autonomously when a
  subagent is useful and to request user confirmation through `sessions_spawn`.
- `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_history`, and
  `sessions_yield` exist as core tools.
- `subagent_sessions` persists the parent run, child conversation, agent id,
  label, status, and message count.
- Chat has an inline `SubagentSessionPanel`.
- Run logs and harness lanes already include subagent coverage.

The gap is product clarity. The current UI can show that a child session exists,
but it does not clearly show the delegated task, child result summary, or what
the parent agent should recover into the final reply.

## Mature Pattern Summary

The best fit is the OpenAI Agents SDK manager pattern, not a handoff takeover.
In the manager pattern, the parent agent owns the user-facing conversation and
uses specialist agents for bounded subtasks. Handoffs are for cases where the
specialist becomes the active user-facing agent.

Openclaw and Accio both reinforce three practical ideas:

- Child work should live in an isolated session with parent-session metadata.
- Completion should produce a compact result/announce record for the parent,
  rather than requiring the parent to poll or parse a full transcript.
- UI should show task state and result summaries, not raw internal protocol
  envelopes.

Vulture should adapt these ideas to its existing SQLite conversation/run model
instead of adding another message store.

## Non-Goals

- Do not add a right-side multi-agent workspace in this slice.
- Do not add manual user delegation controls beyond the existing ApprovalCard.
- Do not add automatic background rewriting of the final parent answer.
- Do not implement `context: fork` in this slice; subagents remain isolated by
  default.
- Do not add complex scheduling, queues, worker pools, or fan-out management.
- Do not replace OpenAI Agents SDK-compatible tool execution with a custom
  orchestration engine.

## Product Behavior

The Chat page keeps the existing inline location, but `SubagentSessionPanel`
becomes a "subtask status" section for the current conversation/run.

Each subtask card shows:

- Subagent name and avatar.
- Task title from `sessions_spawn.title`, falling back to `label`.
- Task objective from `sessions_spawn.message`.
- Status: running, completed, failed, or cancelled.
- Result summary from the latest child assistant message when completed.
- Expand action to inspect recent child messages through the existing messages
  route.

Approval remains represented by the existing ApprovalCard. A subtask card is
created only after the user approves `sessions_spawn` and the child session
exists.

The normal flow should read as:

1. The parent agent proposes delegation through `sessions_spawn`.
2. The user confirms through ApprovalCard.
3. A subtask card appears in Chat with the task title and objective.
4. The card moves from running to completed/failed/cancelled.
5. On completion, the card shows a compact result summary.
6. The parent agent calls `sessions_yield` and incorporates the completed child
   result into its final response.

## Data Model

Add a migration that extends `subagent_sessions` with product-facing metadata:

```text
title             TEXT
task              TEXT
result_summary    TEXT
result_message_id TEXT
completed_at      TEXT
last_error        TEXT
```

Field meanings:

- `title`: short task title from `sessions_spawn.title` or `label`.
- `task`: child task prompt from `sessions_spawn.message`.
- `result_summary`: compact result from the latest child assistant message. In
  this slice it is deterministic truncation, not a model-generated summary.
- `result_message_id`: child assistant message id used for the summary.
- `completed_at`: timestamp when the session first reaches a terminal status.
- `last_error`: latest failure/cancellation reason when available.

`SubagentSessionStore.refreshStatus()` should populate terminal metadata when
it observes a transition to `completed`, `failed`, or `cancelled`. It should not
overwrite an existing `completed_at` unless the session is explicitly reopened
by future behavior.

## API And Tool Outputs

`GET /v1/subagent-sessions` and `GET /v1/subagent-sessions/:id` return the new
metadata fields. `GET /v1/subagent-sessions/:id/messages` remains the detailed
transcript endpoint.

`sessions_spawn` stores `title` and `task` at creation time and returns them
with the session payload. It remains approval-gated and non-idempotent.

`sessions_yield` returns a parent-focused shape:

```json
{
  "active": [],
  "completed": [
    {
      "sessionId": "sub-...",
      "agentId": "researcher",
      "title": "Research dependency options",
      "task": "Compare the supported approaches...",
      "resultSummary": "The child agent found..."
    }
  ],
  "failed": []
}
```

The tool can still include raw `items` for backward compatibility, but the
parent prompt should rely on `active`, `completed`, and `failed` because those
are purpose-built for result recovery.

## Prompt Contract

Keep the parent as the manager:

- Delegate only when the task is independent, parallelizable, or needs a
  configured specialist.
- Do not ask the user to manually pick a subagent.
- Before `sessions_spawn`, provide a clear `title` and a complete `message`.
- After a child task completes, call `sessions_yield` to recover child results.
- Integrate completed results into the final response in the parent agent's
  normal voice.
- If the child fails or the user denies approval, continue without hiding the
  limitation.

This keeps Vulture aligned with the Agents SDK manager pattern while preserving
the existing ApprovalCard human-in-the-loop behavior.

## Error Handling

- Approval denied: no subagent session is created; the parent continues or
  explains that delegation was not allowed.
- Child failed: the card shows failed state and `lastError`; `sessions_yield`
  returns the failed item.
- Child cancelled: the card shows cancelled state; the parent may continue with
  partial work.
- Child still active: `sessions_yield` returns it under `active` with no result
  summary.
- Gateway restart: sessions are reloaded from SQLite, status is re-derived from
  child runs, and terminal metadata remains available.

## Testing And Harness

Implementation should add focused tests:

- Store tests for title/task persistence and terminal metadata population.
- Gateway tool tests for `sessions_spawn` metadata and `sessions_yield`
  active/completed/failed grouping.
- Route tests proving new fields are returned by `/v1/subagent-sessions`.
- UI tests for subtask cards showing title, task, status, result summary,
  failure state, and expandable messages.
- Runtime harness scenario where the model spawns, yields completed child
  result, and writes a final answer that includes the child result.
- Acceptance scenario for spawn -> child completion -> yield -> final answer.

## Acceptance Criteria

- A confirmed `sessions_spawn` creates a visible Chat subtask card with title
  and objective.
- Completed child sessions expose a result summary without reading the full
  transcript.
- `sessions_yield` gives the parent agent a clear completed-result payload.
- The parent final response can include recovered child output in the same run.
- Failed and cancelled children are visible to the user and recoverable through
  `sessions_yield`.
- Existing subagent persistence and restart recovery continue to work.
- `bun run harness:ci` remains green after implementation.
