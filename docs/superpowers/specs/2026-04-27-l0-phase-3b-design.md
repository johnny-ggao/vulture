# Phase 3b — UI Rewrite to Chat-style + Real LLM + Approval Flow

> Sister design to Phase 3a (`2026-04-26-gateway-skeleton-design.md`). Phase 3a built the backend run engine; Phase 3b makes the UI a real client of it, swaps the stub LLM for `@openai/agents`, and wires the approval flow end-to-end.

**Status:** Approved (brainstorm → spec). Implementation plan to follow.

**Companion plan:** `docs/superpowers/plans/2026-04-27-l0-phase-3b-ui-llm.md` (to be written next).

---

## Goal

Replace the placeholder `sendMessage` / `sendMockMessage` paths in `apps/desktop-ui/src/App.tsx` with a real chat-style interface that:

1. Lists persistent conversations from `GET /v1/conversations` (sidebar)
2. Streams assistant tokens, tool calls, and approval prompts from `GET /v1/runs/:rid/events` (SSE)
3. Pauses runs on tool approval prompts and resumes them via `POST /v1/runs/:rid/approvals`
4. Drives runs through real OpenAI calls via `@openai/agents`, replacing `makeStubLlm`

The Phase 3a backend already exposes everything needed (`POST /v1/conversations`, `POST /v1/conversations/:cid/runs`, SSE events with `Last-Event-ID` resume, `/tools/invoke` policy + audit, `recoverInflightOnStartup` sweep). Phase 3b is largely additive on the gateway and shell side, plus a UI rewrite.

---

## Scope

| Item | In | Out |
|---|---|---|
| Real LLM via `@openai/agents` | ✅ | — |
| Multi-conversation sidebar (ChatGPT-style lifecycle) | ✅ | — |
| SSE auto-reconnect with `Last-Event-ID` + exponential backoff | ✅ | — |
| Tool call inline rendering (smart expand / collapse) | ✅ | — |
| Approval flow end-to-end (tool.ask → user click → run resumes) | ✅ | — |
| Cross-process resume of in-flight run after window close | — | ❌ Phase 4+ |
| Conversation title generation by LLM | — | ❌ later (use first 40 chars of input as M6 default) |
| Mock mode in UI | — | ❌ removed; dev tools cover this |
| Approval timeout / TTL | — | ❌ Phase 4+ (in-memory queue dies with gateway, behavior identical to spec recovery) |
| Browser tools (`browser.snapshot`, `browser.click`) actually executing | — | ❌ Phase 4+ (still emit `tool.ask`, can be denied) |

---

## Design decisions (from brainstorm)

| Question | Decision |
|---|---|
| Q1 — Phase 3b scope | **C**: MVP + multi-conversation history + approval flow + real LLM |
| Q2 — Conversation lifecycle | **a**: ChatGPT-style — explicit "+ 新消息" creates a new conversation; sends within a conversation accumulate. Sidebar = persistent list. |
| Q3 — Reconnect behaviour | **b**: Auto-reconnect with `Last-Event-ID`. Exponential backoff (1/2/4/8/16s, capped). No cross-process persistence. |
| Q4 — Approval UX placement | **C**: Inline message in conversation thread. Coloured side bar + amber theme for visibility. Multiple ask events stack naturally. |
| Q5 — Tool call rendering | **C**: Smart expand/collapse — running auto-expanded, completed collapsed to one line, failed auto-expanded with error inline. Click title to toggle manually. Long output truncated with "show N more lines". |
| Q6 — Backend approval architecture | **b + partial c**: `makeShellCallbackTools` blocks on an in-memory `ApprovalQueue` keyed by `callId`. `POST /v1/runs/:rid/approvals` resolves it. Rust `PolicyEngine::for_workspace` returns `Allow` for `shell.exec` whose `cwd` is inside the workspace path; otherwise `Ask`. Other tools unchanged. |

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│ UI (apps/desktop-ui)                                                │
│                                                                     │
│  ┌──────────────────┐    ┌─────────────────┐   ┌────────────────┐   │
│  │ ConversationList │    │ ChatView        │   │ Composer       │   │
│  │ (sidebar)        │    │ - MessageList   │   │ (textarea + ↑) │   │
│  │ + 新消息         │←──→│ - RunEventStream│←──│                │   │
│  │ • 会话A          │    │   - Bubbles     │   └────────────────┘   │
│  │ • 会话B  (active)│    │   - ToolBlock   │            ↓           │
│  │ • 会话C          │    │   - ApprovalCard│   POST /v1/runs        │
│  └──────────────────┘    └─────────────────┘            ↓           │
│           ↑                       ↑                                 │
│  GET /v1/conversations    SSE: GET /v1/runs/:rid/events             │
└───────────│───────────────────────│─────────────────────────────────┘
            │                       │
            │     ┌─────────────────────────────────────────────────┐
            │     │ Gateway (apps/gateway)                          │
            │     │                                                 │
            └─────│  ConversationStore + MessageStore + RunStore    │
                  │  (existing, no change)                          │
                  │                                                 │
                  │  runner ←  makeOpenAILlm() (replaces stub)      │
                  │     │       └ @openai/agents Run                │
                  │     ↓                                           │
                  │  makeShellCallbackTools()                       │
                  │     │  on status=ask:                           │
                  │     │    • emit tool.ask via runStore           │
                  │     │    • await approvalQueue.wait(callId)     │
                  │     │    • re-POST /tools/invoke + token        │
                  │     │                                           │
                  │  POST /v1/runs/:rid/approvals  →                │
                  │     resolves approvalQueue                      │
                  └────────────────│────────────────────────────────┘
                                   │
                                   ↓ HTTP /tools/invoke
              ┌──────────────────────────────────────────┐
              │ Shell (apps/desktop-shell tool_callback) │
              │                                          │
              │  PolicyEngine::for_workspace(path)       │
              │     • shell.exec inside workspace = Allow│
              │     • shell.exec outside        = Ask    │
              │     • browser.*                 = Ask    │
              │  AuditStore (already wired in FU-4)      │
              │  tool_executor::execute_shell            │
              └──────────────────────────────────────────┘
```

---

## Backend

### Gateway

**`apps/gateway/src/runtime/approvalQueue.ts`** — new module.

```ts
export type Decision = "allow" | "deny";

export class ApprovalQueue {
  private pending = new Map<string, (d: Decision) => void>();

  wait(callId: string, signal: AbortSignal): Promise<Decision> {
    return new Promise((resolve, reject) => {
      this.pending.set(callId, resolve);
      signal.addEventListener("abort", () => {
        this.pending.delete(callId);
        reject(new Error("approval wait aborted"));
      });
    });
  }

  resolve(callId: string, decision: Decision): boolean {
    const cb = this.pending.get(callId);
    if (!cb) return false;
    this.pending.delete(callId);
    cb(decision);
    return true;
  }
}
```

Constructed once in `buildServer`; injected into `runsRouter` as a new dep. The `AbortSignal` is wired to the run cancellation path so a cancelled run unblocks its pending approvals with a rejection.

**`apps/gateway/src/runtime/openaiLlm.ts`** — new module replacing the stub LLM.

```ts
import { Agent, run } from "@openai/agents";
import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";
import { selectModel } from "@vulture/llm";

export function makeOpenAILlm(opts: {
  apiKey: string;
  toolNames: readonly string[];   // ["shell.exec", "browser.snapshot", "browser.click"]
}): LlmCallable {
  // Construct an Agent with tool stubs whose `execute` rejects to a sentinel;
  // the actual execution is intercepted by the runner via the LlmYield protocol.
  // (Exact mapping spelled out in the implementation plan.)
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    const agent = new Agent({ ... });
    const stream = run(agent, input.userInput, { stream: true });
    for await (const event of stream) {
      // translate SDK events → LlmYield
    }
  };
}

export function makeStubLlmFallback(): LlmCallable { ... }  // when OPENAI_API_KEY missing
```

The exact SDK event → `LlmYield` translation is non-trivial (the SDK has its own tool-call lifecycle). The implementation plan spells out the table and edge cases. Phase 3b commits one task per yield kind with focused tests.

`buildServer` selects:
```ts
const llm: LlmCallable = isApiKeyConfigured(process.env)
  ? makeOpenAILlm({ apiKey: process.env.OPENAI_API_KEY!, toolNames: AGENT_TOOL_NAMES })
  : makeStubLlmFallback();
```

**`apps/gateway/src/server.ts::makeShellCallbackTools` rework**

The function is now built with closures for `appendEvent` (from RunStore) and `approvalQueue`:

```ts
function makeShellCallbackTools(opts: {
  callbackUrl: string;
  token: string;
  appendEvent: (runId: string, partial: PartialRunEvent) => void;
  approvalQueue: ApprovalQueue;
  cancelSignals: Map<string, AbortController>;  // per-run cancel
}): ToolCallable {
  return async (call) => {
    let approvalToken: string | undefined;
    while (true) {  // loop max 1 — first pass possibly ask, second pass executes
      const res = await fetch(`${opts.callbackUrl}/tools/invoke`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "X-Caller-Pid": String(process.pid) },
        body: JSON.stringify({ ...call, approvalToken }),
      });
      const body = await res.json() as InvokeResponse;

      if (body.status === "completed") return body.output;
      if (body.status === "denied")
        throw new ToolCallError(body.error.code, body.error.message);
      if (body.status === "failed")
        throw new ToolCallError(body.error.code, body.error.message);

      if (body.status === "ask") {
        opts.appendEvent(call.runId, {
          type: "tool.ask",
          callId: call.callId,
          tool: call.tool,
          reason: body.reason,
          approvalToken: body.approvalToken,
        });
        const cancelSignal = opts.cancelSignals.get(call.runId)!.signal;
        const decision = await opts.approvalQueue.wait(call.callId, cancelSignal);
        if (decision === "deny") {
          throw new ToolCallError("tool.permission_denied", `user denied ${call.tool}`);
        }
        approvalToken = body.approvalToken;
        // loop again — second invocation carries token, Rust skips PolicyEngine
      }
    }
  };
}
```

`cancelSignals` is a `Map<runId, AbortController>` populated by the orchestrator when a run starts and aborted on `POST /v1/runs/:rid/cancel`. This unblocks `approvalQueue.wait` on cancel.

**`POST /v1/runs/:rid/approvals` route** (currently a stub returning 202)

Validates body `{ callId: string, decision: "allow" | "deny" }` with a new `ApprovalRequestSchema`. Calls `approvalQueue.resolve(callId, decision)`. Returns 202 on success, 404 if no pending approval for that callId.

### Rust shell

**`crates/tool-gateway/src/policy.rs::PolicyEngine`** — extend the `shell.exec` arm.

Currently:
```rust
"shell.exec" => PolicyDecision::Ask { reason: "shell.exec requires approval".into() },
```

After:
```rust
"shell.exec" => self.decide_shell_exec(request),
```

Where `decide_shell_exec` parses `request.input.cwd` and:
- If empty workspace_root → `Ask` (no workspace context)
- If `cwd` resolves under `workspace_root` → `Allow`
- Otherwise → `Ask`

Reuses the existing `normalize_root` helper. Audit logging already in place via FU-4.

**`apps/desktop-shell/src/tool_callback.rs::InvokeRequest`** — add optional approval token.

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeRequest {
    call_id: String,
    run_id: String,
    tool: String,
    input: Value,
    workspace_path: String,
    approval_token: Option<String>,  // NEW
}
```

`invoke_handler`:
```rust
if let Some(token) = &req.approval_token {
    // Token presence = gateway has already authenticated this approval.
    // Skip PolicyEngine.decide and execute directly. Audit the bypass.
    state.audit_store.lock().ok().and_then(|mut s| s.append("tool.approval_used", &json!({ "callId": req.call_id, "token": token })).ok());
    return execute(&req).await.into_response();
}
// ... existing PolicyEngine path ...
```

The token is opaque — Rust doesn't validate its provenance beyond "non-empty + present". The gateway is the trust root; the token is a one-time correlation handle.

### Protocol

**`packages/protocol/src/v1/approval.ts`** — new file.

```ts
import { z } from "zod";

export const ApprovalRequestSchema = z.object({
  callId: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
}).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
```

`InvokeResponse` Rust→TS shape (already implicit, formalize):
```ts
export type InvokeResponse =
  | { status: "completed"; callId: string; output: unknown }
  | { status: "failed";    callId: string; error: AppError }
  | { status: "denied";    callId: string; error: AppError }
  | { status: "ask";       callId: string; approvalToken: string; reason: string };
```

Defined in `apps/gateway/src/runtime/shellWire.ts` (gateway-internal, not exported as protocol — Rust is the spec source).

---

## UI

### File structure

```
apps/desktop-ui/src/
├── api/
│   ├── client.ts                 (existing)
│   ├── conversations.ts          NEW
│   ├── runs.ts                   NEW
│   └── sse.ts                    NEW
├── runtime/useRuntimeDescriptor.ts (existing)
├── chat/                         NEW directory
│   ├── ConversationList.tsx
│   ├── ChatView.tsx
│   ├── MessageBubble.tsx
│   ├── ToolBlock.tsx
│   ├── ApprovalCard.tsx
│   ├── Composer.tsx
│   └── RunEventStream.tsx
├── hooks/
│   ├── useConversations.ts
│   ├── useMessages.ts
│   ├── useRunStream.ts
│   └── useApproval.ts
└── App.tsx                       SHRUNK to ~100 lines
```

### State management

No external store. Each hook is self-contained:

| Hook | Responsibility |
|---|---|
| `useConversations(client)` | List + create + delete; `useReducer` for optimistic updates; refetch on focus |
| `useMessages(client, cid)` | List since cursor; refetch on conversation switch |
| `useRunStream(client, runId)` | SSE consumer; produces `{status, events, error}`; auto-reconnect |
| `useApproval(client, runId, events)` | Derive pending approvals from events; expose `decide(callId, decision)` |

`App.tsx` owns `activeConversationId`, `selectedAgentId`, `authStatus`. Shrunk from 458 lines to ~100.

### SSE consumer (`apps/desktop-ui/src/api/sse.ts`)

`EventSource` doesn't support `Authorization: Bearer`, so hand-rolled (~80 lines).

```ts
export async function* sseStream(opts: {
  url: string;
  token: string;
  lastEventId?: string;
  signal: AbortSignal;
}): AsyncGenerator<{ id: string; event: string; data: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "text/event-stream",
  };
  if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

  const res = await fetch(opts.url, { headers, signal: opts.signal });
  if (!res.ok) throw new SseError(`SSE HTTP ${res.status}`, res.status);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();

  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      yield parseFrame(frame);  // {id, event, data}
    }
  }
}
```

### Reconnect (`useRunStream`)

Pseudo:
```ts
function useRunStream(client, runId) {
  // state: { status, events, error, lastSeq }
  // effect:
  //   while (!terminal && !aborted) {
  //     try {
  //       for await frame of sseStream({ url, token, lastEventId: lastSeq, signal }):
  //         dispatch(parseRunEvent(frame));
  //     } catch (err if !aborted): {
  //       backoff = min(16000, 1000 * 2 ** retry);
  //       set status="reconnecting", error=err;
  //       await sleep(backoff);
  //       retry++;
  //     }
  //   }
}
```

Reset retry counter on every successful frame received. Status surfaces to UI as a small "重连中…" chip in the ChatView header.

### Approval data path

1. SSE frame `{event: "tool.ask", data: {callId, tool, reason, approvalToken, ...}}` arrives.
2. `useRunStream` reduces it into the events array.
3. `useApproval` filters events for `tool.ask` not yet superseded by `tool.completed` / `tool.failed` / `run.cancelled`.
4. `RunEventStream` renders an `<ApprovalCard>` inline at the position of the `tool.ask` event.
5. User clicks "允许" → `useApproval.decide(callId, "allow")` → `runs.approve(client, runId, {callId, decision: "allow"})`.
6. Optimistically marks the card "处理中" while the POST is in flight.
7. Backend resumes; new `tool.started` / `tool.completed` events arrive over SSE.
8. The ApprovalCard is replaced by the regular tool block via the events array reduction.

### Composer behaviour

- Textarea + agent dropdown (existing) + ↑ send.
- During run: ↑ becomes ⏹ (cancel). Click → `runs.cancel(client, runId)`.
- Mock button removed; dev tool path is `bun apps/gateway/src/main.ts` with stub LLM via missing `OPENAI_API_KEY`.
- Send action:
  1. If no `activeConversationId`: `POST /v1/conversations` with `agentId = selectedAgentId`, `title = input.slice(0, 40)`.
  2. `POST /v1/conversations/:cid/runs` with `{input}`, get `{run, message, eventStreamUrl}`.
  3. Set `activeRunId = run.id`; subscribe via `useRunStream`.
- Pressing Enter without Shift sends; Shift+Enter newline.

---

## Migration milestones

Each milestone is its own commit, independently testable, build green between commits.

| M | Title | Touches |
|---|---|---|
| M1 | Protocol + API client + SSE utility | `packages/protocol/src/v1/approval.ts`; `apps/desktop-ui/src/api/{conversations,runs,sse}.ts` + tests |
| M2 | Backend approval queue + Rust workspace allow + token bypass | `apps/gateway/src/runtime/approvalQueue.ts`; `crates/tool-gateway/src/policy.rs`; `apps/desktop-shell/src/tool_callback.rs`; `apps/gateway/src/{server,routes/runs}.ts` |
| M3 | Real LLM (`@openai/agents`) | `apps/gateway/src/runtime/openaiLlm.ts`; `apps/gateway/src/server.ts` selection logic |
| M4 | UI hooks | `apps/desktop-ui/src/hooks/{useConversations,useMessages,useRunStream,useApproval}.ts` + tests |
| M5 | UI components | `apps/desktop-ui/src/chat/*.tsx` + tests |
| M6 | App.tsx rewrite | `apps/desktop-ui/src/App.tsx` shrunk; integration test |
| M7 | Cleanup | dead CSS, README/CHANGELOG |

---

## Testing strategy

| Layer | Tests |
|---|---|
| protocol | Zod parse + reject for ApprovalRequest |
| gateway routes/runs (existing) | Extended for approvals route, cancel-unblocks-approval-queue |
| ApprovalQueue | wait/resolve order, multi-callId, abort path |
| openaiLlm | SDK event mock → LlmYield translation; missing-key fallback path |
| Rust tool_callback | InvokeRequest with `approvalToken` skips policy + writes audit |
| Rust PolicyEngine | shell.exec inside vs outside workspace_root |
| UI api/sse | Mock fetch + ReadableStream; frame parsing; reconnect on error |
| UI hooks | Mock api client; happy path + reconnect + cancel |
| UI components | React Testing Library: render + key interactions |
| Gateway integration | Existing runs.integration.test.ts extended with real ApprovalQueue path |
| Manual smoke | `cargo tauri dev` → real key → send → tool ask → approve → completion |

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@openai/agents` SDK API shape unstable | Medium | M3 stalls | M3 starts with `bun add` + reading current docs; mock-test before touching live API |
| SSE long connection killed by Tauri webview / OS | Medium | UI breaks mid-stream | Last-Event-ID resume covers it; manual smoke in M6 to confirm |
| ApprovalQueue lost on gateway restart | Low | In-flight ask drops | Identical to spec recovery: `recoverInflightOnStartup` marks the run failed; UI reconnect sees `run.failed` |
| Long LLM call exceeds keepalive | Medium | Stream drops | Periodic SSE heartbeat (`event: ping`) every 15s + Last-Event-ID resume |
| Rust ↔ TS InvokeResponse drift | High | Silent runtime failures | Round-trip test in M2 (TS sends, Rust receives, vice versa) |
| Tauri CSP blocks `connect-src 127.0.0.1:<port>` | Low | App can't talk to gateway | Already vetted in Phase 2; Tauri config explicitly allows |
| @openai/agents workspace dep collision | Low | Build fails | Already a dep in `packages/llm` and `packages/agent-runtime` |
| First-run user has no `OPENAI_API_KEY` | High | Empty stream | Fallback to stub LLM that yields `"OPENAI_API_KEY not configured. Configure in settings."` as final text; clear UI hint |

---

## Out of scope (Phase 3b → Phase 4)

- Cross-process resume of in-flight runs after Tauri window close (FU-shaped follow-up; persist `lastSeenSeq` per run in `localStorage`)
- LLM-generated conversation titles (use first 40 chars for now)
- Approval timeout / TTL (in-memory queue is fine for MVP)
- Browser tools real execution (`browser.click`, `browser.snapshot`) — manifest still advertises them; PolicyEngine returns Ask; tool_executor falls through to `not yet wired in 3a/3b`
- Approval policy memory ("don't ask again for this command") — Phase 4 + UI design
- Streaming reasoning tokens / chain-of-thought display
- Multi-agent / agent handoff within a conversation

---

## Acceptance criteria

- A user with `OPENAI_API_KEY` configured can: open Vulture → click "+ 新消息" → type "list workspace files" → see streaming text in real time → see `shell.exec ls` block (auto-allowed in workspace) → see assistant summarize.
- A user runs a command outside the workspace (e.g. `shell.exec rm /tmp/foo`) and sees an inline approval card; clicking "允许" resumes the run, "拒绝" produces a `tool.failed (tool.permission_denied)` event and the agent adapts its plan.
- Killing Wi-Fi mid-run → UI shows "重连中…" chip → restoring Wi-Fi → run resumes streaming, no event loss.
- Closing and reopening the app: conversations sidebar shows past conversations; clicking one shows full message history. Active run from the previous session is in `failed` state with `internal.gateway_restarted` (Phase 3a sweep).
- Without `OPENAI_API_KEY`: send produces a single assistant message explaining the missing key.
- Cancelling a run mid-stream (⏹ button): SSE stream closes; run marked `cancelled`; pending approvals are released with rejection (logged but suppressed in UI).
- `grep -r "start_agent_run\|start_mock_run" apps/` returns nothing (already true post-3a).

---

## Open questions

None at design time. Implementation plan will spell out the `@openai/agents` event mapping table and the exact SSE heartbeat cadence — both are technical implementation details, not architectural choices.
