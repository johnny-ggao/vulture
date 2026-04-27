# L0 Phase 3b — UI Rewrite + Real LLM + Approval Flow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the desktop UI as a real chat client of the Phase 3a backend, swap the gateway's stub LLM for `@openai/agents`, and wire the approval flow end-to-end (`tool.ask` → user click → run resumes via `POST /v1/runs/:rid/approvals`).

**Architecture:** UI consumes `GET /v1/conversations` and SSE `GET /v1/runs/:rid/events`. Gateway runs `@openai/agents` in `runner.ts`'s LlmCallable slot when `OPENAI_API_KEY` is configured (else stub fallback). `makeShellCallbackTools` blocks on an in-memory `ApprovalQueue` for `tool.ask` responses; `POST /v1/runs/:rid/approvals` resolves the queue. Rust `PolicyEngine::for_workspace` allows `shell.exec` whose `cwd` is inside the workspace; `tool_callback.rs` accepts an optional `approvalToken` to bypass policy on the second pass.

**Tech Stack:**
- Bun + TypeScript: `@openai/agents` (already a workspace dep), `hono` (SSE), `bun:sqlite` (existing)
- React 18 + Vite for UI; hand-rolled SSE consumer (no EventSource — needs Bearer header)
- Rust + axum: minimal — one branch in PolicyEngine, one optional field in InvokeRequest
- Tests: `bun test` everywhere; `happy-dom` + `@testing-library/react` introduced in M5 prep for component tests

**Spec:** [`docs/superpowers/specs/2026-04-27-l0-phase-3b-design.md`](../specs/2026-04-27-l0-phase-3b-design.md)

**Direct-on-main mode:** typecheck MUST exit 0 before each commit. Use `readFileSync`/`bun:sqlite`/UUID temp dirs. No `--no-verify`. Each task is one commit; build/tests stay green between commits.

---

## File structure (created/modified)

```text
packages/protocol/src/v1/
└── approval.ts                  NEW: ApprovalRequestSchema (callId + decision)

apps/gateway/src/
├── runtime/
│   ├── approvalQueue.ts         NEW: in-memory wait/resolve keyed by callId
│   ├── openaiLlm.ts             NEW: @openai/agents wrapper → LlmYield protocol
│   └── runOrchestrator.ts       MODIFIED: cancelSignals Map + per-run AbortController
├── routes/
│   └── runs.ts                  MODIFIED: real approvals route + cancel propagates abort
└── server.ts                    MODIFIED: instantiate ApprovalQueue, choose LLM by env

apps/desktop-shell/src/
└── tool_callback.rs             MODIFIED: InvokeRequest.approval_token; bypass on token

crates/tool-gateway/src/
└── policy.rs                    MODIFIED: decide_shell_exec(cwd inside workspace = Allow)

apps/desktop-ui/src/
├── api/
│   ├── conversations.ts         NEW: list/create/get/listMessages/delete
│   ├── runs.ts                  NEW: create/get/cancel/approve
│   └── sse.ts                   NEW: hand-rolled async generator + parser
├── chat/                        NEW directory
│   ├── ConversationList.tsx
│   ├── ChatView.tsx
│   ├── MessageBubble.tsx
│   ├── ToolBlock.tsx
│   ├── ApprovalCard.tsx
│   ├── Composer.tsx
│   └── RunEventStream.tsx
├── hooks/                       NEW directory
│   ├── useConversations.ts
│   ├── useMessages.ts
│   ├── useRunStream.ts
│   └── useApproval.ts
├── App.tsx                      REWRITTEN: shrink to ~120 lines, integrate
└── styles.css                   MODIFIED: add chat/* styles + drop dead classes

bunfig.toml                      MODIFIED: preload @happy-dom/global-registrator for UI tests
```

---

## Group A — Protocol

### Task 1: `protocol/v1/approval.ts`

**Files:**
- Create: `packages/protocol/src/v1/approval.ts`
- Create: `packages/protocol/src/v1/approval.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/protocol/src/v1/approval.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { ApprovalRequestSchema } from "./approval";

describe("ApprovalRequestSchema", () => {
  test("parses allow decision", () => {
    expect(ApprovalRequestSchema.parse({ callId: "c1", decision: "allow" })).toEqual({
      callId: "c1",
      decision: "allow",
    });
  });

  test("parses deny decision", () => {
    expect(ApprovalRequestSchema.parse({ callId: "c1", decision: "deny" }).decision).toBe("deny");
  });

  test("rejects unknown decision", () => {
    expect(() => ApprovalRequestSchema.parse({ callId: "c1", decision: "maybe" })).toThrow();
  });

  test("rejects empty callId", () => {
    expect(() => ApprovalRequestSchema.parse({ callId: "", decision: "allow" })).toThrow();
  });

  test("rejects extra fields (strict)", () => {
    expect(() =>
      ApprovalRequestSchema.parse({ callId: "c1", decision: "allow", extra: "nope" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**: `bun test packages/protocol/src/v1/approval.test.ts`

- [ ] **Step 3: Write `packages/protocol/src/v1/approval.ts`**

```ts
import { z } from "zod";
import { ApprovalDecisionSchema } from "./tool";

export const ApprovalRequestSchema = z
  .object({
    callId: z.string().min(1),
    decision: ApprovalDecisionSchema,
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
```

- [ ] **Step 4: Run, expect 5 PASS** + typecheck

```bash
bun test packages/protocol/src/v1/approval.test.ts
bun --filter @vulture/protocol typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add v1 ApprovalRequest schema"
```

---

## Group B — UI API client + SSE consumer

### Task 2: `api/conversations.ts`

**Files:**
- Create: `apps/desktop-ui/src/api/conversations.ts`
- Create: `apps/desktop-ui/src/api/conversations.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/api/conversations.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { conversationsApi, type ConversationDto } from "./conversations";
import type { ApiClient } from "./client";

function fakeClient(handlers: Partial<ApiClient>): ApiClient {
  return {
    get: handlers.get ?? (async () => ({} as never)),
    post: handlers.post ?? (async () => ({} as never)),
    patch: handlers.patch ?? (async () => ({} as never)),
    delete: handlers.delete ?? (async () => undefined),
  } as ApiClient;
}

const sample: ConversationDto = {
  id: "c-1",
  agentId: "local-work-agent",
  title: "Hello",
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
};

describe("conversationsApi", () => {
  test("list strips items envelope", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations");
        return { items: [sample] } as T;
      },
    });
    expect(await conversationsApi.list(client)).toEqual([sample]);
  });

  test("list with agentId appends query", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations?agentId=a-1");
        return { items: [] } as T;
      },
    });
    await conversationsApi.list(client, { agentId: "a-1" });
  });

  test("create posts body and returns conv", async () => {
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/conversations");
        expect(body).toEqual({ agentId: "a-1", title: "Hi" });
        return sample as T;
      },
    });
    expect(await conversationsApi.create(client, { agentId: "a-1", title: "Hi" })).toEqual(sample);
  });

  test("listMessages without afterMessageId omits query", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations/c-1/messages");
        return { items: [] } as T;
      },
    });
    await conversationsApi.listMessages(client, "c-1");
  });

  test("listMessages with afterMessageId appends query", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations/c-1/messages?afterMessageId=m-2");
        return { items: [] } as T;
      },
    });
    await conversationsApi.listMessages(client, "c-1", "m-2");
  });

  test("delete sends DELETE", async () => {
    let called = false;
    const client = fakeClient({
      delete: async (path: string) => {
        expect(path).toBe("/v1/conversations/c-1");
        called = true;
      },
    });
    await conversationsApi.delete(client, "c-1");
    expect(called).toBe(true);
  });
});
```

- [ ] **Step 2: Run, FAIL**: `bun test apps/desktop-ui/src/api/conversations.test.ts`

- [ ] **Step 3: Write `apps/desktop-ui/src/api/conversations.ts`**

```ts
import type { ApiClient } from "./client";

export interface ConversationDto {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  runId: string | null;
  createdAt: string;
}

export interface CreateConversationRequest {
  agentId: string;
  title?: string;
}

export const conversationsApi = {
  list: async (client: ApiClient, filter?: { agentId?: string }) => {
    const path = filter?.agentId
      ? `/v1/conversations?agentId=${encodeURIComponent(filter.agentId)}`
      : "/v1/conversations";
    return (await client.get<{ items: ConversationDto[] }>(path)).items;
  },

  create: (client: ApiClient, body: CreateConversationRequest) =>
    client.post<ConversationDto>("/v1/conversations", body),

  get: (client: ApiClient, id: string) => client.get<ConversationDto>(`/v1/conversations/${id}`),

  listMessages: async (client: ApiClient, id: string, afterMessageId?: string) => {
    const path = afterMessageId
      ? `/v1/conversations/${id}/messages?afterMessageId=${encodeURIComponent(afterMessageId)}`
      : `/v1/conversations/${id}/messages`;
    return (await client.get<{ items: MessageDto[] }>(path)).items;
  },

  delete: (client: ApiClient, id: string) => client.delete(`/v1/conversations/${id}`),
};
```

- [ ] **Step 4: Run, expect 6 PASS** + typecheck

```bash
bun test apps/desktop-ui/src/api/conversations.test.ts
bun --filter @vulture/desktop-ui typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): conversations API client"
```

### Task 3: `api/runs.ts`

**Files:**
- Create: `apps/desktop-ui/src/api/runs.ts`
- Create: `apps/desktop-ui/src/api/runs.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/api/runs.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { runsApi, type CreateRunResponse, type RunDto } from "./runs";
import type { ApiClient } from "./client";

function fakeClient(handlers: Partial<ApiClient>): ApiClient {
  return {
    get: handlers.get ?? (async () => ({} as never)),
    post: handlers.post ?? (async () => ({} as never)),
    patch: handlers.patch ?? (async () => ({} as never)),
    delete: handlers.delete ?? (async () => undefined),
  } as ApiClient;
}

const sampleRun: RunDto = {
  id: "r-1",
  conversationId: "c-1",
  agentId: "a-1",
  status: "queued",
  triggeredByMessageId: "m-1",
  resultMessageId: null,
  startedAt: "2026-04-27T00:00:00.000Z",
  endedAt: null,
  error: null,
};

describe("runsApi", () => {
  test("create posts to nested path with input", async () => {
    const expected: CreateRunResponse = {
      run: sampleRun,
      message: {
        id: "m-1",
        conversationId: "c-1",
        role: "user",
        content: "hi",
        runId: null,
        createdAt: "2026-04-27T00:00:00.000Z",
      },
      eventStreamUrl: "/v1/runs/r-1/events",
    };
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/conversations/c-1/runs");
        expect(body).toEqual({ input: "hi" });
        return expected as T;
      },
    });
    expect(await runsApi.create(client, "c-1", { input: "hi" })).toEqual(expected);
  });

  test("get fetches the run", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/runs/r-1");
        return sampleRun as T;
      },
    });
    expect(await runsApi.get(client, "r-1")).toEqual(sampleRun);
  });

  test("cancel posts to cancel path", async () => {
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/runs/r-1/cancel");
        expect(body).toEqual({});
        return sampleRun as T;
      },
    });
    await runsApi.cancel(client, "r-1");
  });

  test("approve posts callId + decision", async () => {
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/runs/r-1/approvals");
        expect(body).toEqual({ callId: "tool-call-1", decision: "allow" });
        return undefined as T;
      },
    });
    await runsApi.approve(client, "r-1", { callId: "tool-call-1", decision: "allow" });
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/api/runs.ts`**

```ts
import type { ApiClient } from "./client";
import type { MessageDto } from "./conversations";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunDto {
  id: string;
  conversationId: string;
  agentId: string;
  status: RunStatus;
  triggeredByMessageId: string;
  resultMessageId: string | null;
  startedAt: string;
  endedAt: string | null;
  error: { code: string; message: string } | null;
}

export interface CreateRunResponse {
  run: RunDto;
  message: MessageDto;
  eventStreamUrl: string;
}

export type ApprovalDecision = "allow" | "deny";

export interface ApprovalRequest {
  callId: string;
  decision: ApprovalDecision;
}

export const runsApi = {
  create: (client: ApiClient, conversationId: string, body: { input: string }) =>
    client.post<CreateRunResponse>(`/v1/conversations/${conversationId}/runs`, body),

  get: (client: ApiClient, runId: string) => client.get<RunDto>(`/v1/runs/${runId}`),

  cancel: (client: ApiClient, runId: string) =>
    client.post<RunDto>(`/v1/runs/${runId}/cancel`, {}),

  approve: (client: ApiClient, runId: string, body: ApprovalRequest) =>
    client.post<void>(`/v1/runs/${runId}/approvals`, body),
};
```

- [ ] **Step 4: Run, expect 4 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): runs API client (create/get/cancel/approve)"
```

### Task 4: `api/sse.ts` — hand-rolled SSE consumer

**Files:**
- Create: `apps/desktop-ui/src/api/sse.ts`
- Create: `apps/desktop-ui/src/api/sse.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/api/sse.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { parseFrame, sseStream } from "./sse";

describe("parseFrame", () => {
  test("parses standard frame", () => {
    expect(parseFrame("id: 5\nevent: text.delta\ndata: hello")).toEqual({
      id: "5",
      event: "text.delta",
      data: "hello",
    });
  });

  test("multiline data joined with newline", () => {
    expect(parseFrame("event: x\ndata: line1\ndata: line2").data).toBe("line1\nline2");
  });

  test("missing fields default to empty string", () => {
    expect(parseFrame("data: only-data")).toEqual({ id: "", event: "message", data: "only-data" });
  });

  test("ignores comment lines starting with :", () => {
    expect(parseFrame(": ping\nid: 1\nevent: e\ndata: d").event).toBe("e");
  });
});

function makeStreamResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("sseStream", () => {
  test("yields parsed frames in order", async () => {
    const fetchMock = (async () =>
      makeStreamResponse([
        "id: 0\nevent: run.started\ndata: {}\n\n",
        "id: 1\nevent: text.delta\ndata: hello\n\n",
      ])) as typeof fetch;
    const frames: Array<{ id: string; event: string }> = [];
    for await (const frame of sseStream({
      url: "/v1/runs/r/events",
      token: "tok",
      signal: new AbortController().signal,
      fetch: fetchMock,
    })) {
      frames.push({ id: frame.id, event: frame.event });
    }
    expect(frames).toEqual([
      { id: "0", event: "run.started" },
      { id: "1", event: "text.delta" },
    ]);
  });

  test("handles frames split across chunks", async () => {
    const fetchMock = (async () =>
      makeStreamResponse(["id: 0\nevent: a\ndata: ", "x\n", "\n"])) as typeof fetch;
    const frames: string[] = [];
    for await (const frame of sseStream({
      url: "/x",
      token: "t",
      signal: new AbortController().signal,
      fetch: fetchMock,
    })) {
      frames.push(frame.data);
    }
    expect(frames).toEqual(["x"]);
  });

  test("sends Last-Event-ID header when provided", async () => {
    let captured: Headers | undefined;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      captured = new Headers(init.headers);
      return makeStreamResponse([]);
    }) as typeof fetch;
    const iter = sseStream({
      url: "/x",
      token: "t",
      lastEventId: "5",
      signal: new AbortController().signal,
      fetch: fetchMock,
    });
    await iter.next();
    expect(captured?.get("Last-Event-ID")).toBe("5");
    expect(captured?.get("Authorization")).toBe("Bearer t");
  });

  test("throws on non-2xx response", async () => {
    const fetchMock = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const iter = sseStream({
      url: "/x",
      token: "t",
      signal: new AbortController().signal,
      fetch: fetchMock,
    });
    await expect(iter.next()).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/api/sse.ts`**

```ts
export interface SseFrame {
  id: string;
  event: string;
  data: string;
}

export interface SseStreamOptions {
  url: string;
  token: string;
  lastEventId?: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

export class SseError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SseError";
    this.status = status;
  }
}

export function parseFrame(raw: string): SseFrame {
  let id = "";
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value =
      colon === -1 ? "" : line[colon + 1] === " " ? line.slice(colon + 2) : line.slice(colon + 1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  return { id, event, data: dataLines.join("\n") };
}

export async function* sseStream(opts: SseStreamOptions): AsyncGenerator<SseFrame, void, unknown> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "text/event-stream",
  };
  if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

  const res = await f(opts.url, { headers, signal: opts.signal });
  if (!res.ok) throw new SseError(`SSE HTTP ${res.status}`, res.status);
  if (!res.body) return;

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim().length > 0) yield parseFrame(buffer);
        return;
      }
      buffer += value;
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        yield parseFrame(frame);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort cleanup
    }
  }
}
```

- [ ] **Step 4: Run, expect 8 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): hand-rolled SSE consumer with Last-Event-ID + abort support"
```

---

## Group C — Backend ApprovalQueue + Rust workspace allow + token bypass

### Task 5: `apps/gateway/src/runtime/approvalQueue.ts`

**Files:**
- Create: `apps/gateway/src/runtime/approvalQueue.ts`
- Create: `apps/gateway/src/runtime/approvalQueue.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/runtime/approvalQueue.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { ApprovalQueue } from "./approvalQueue";

describe("ApprovalQueue", () => {
  test("resolve unblocks wait with the decision", async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const promise = q.wait("c1", ac.signal);
    expect(q.resolve("c1", "allow")).toBe(true);
    expect(await promise).toBe("allow");
  });

  test("resolve before wait returns false (no listener)", () => {
    const q = new ApprovalQueue();
    expect(q.resolve("missing", "allow")).toBe(false);
  });

  test("multiple callIds independent", async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const a = q.wait("c1", ac.signal);
    const b = q.wait("c2", ac.signal);
    q.resolve("c2", "deny");
    q.resolve("c1", "allow");
    expect(await a).toBe("allow");
    expect(await b).toBe("deny");
  });

  test("abort rejects the promise and cleans up", async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const promise = q.wait("c1", ac.signal);
    ac.abort();
    await expect(promise).rejects.toThrow(/aborted/);
    expect(q.resolve("c1", "allow")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, FAIL**: `bun test apps/gateway/src/runtime/approvalQueue.test.ts`

- [ ] **Step 3: Write `apps/gateway/src/runtime/approvalQueue.ts`**

```ts
export type ApprovalDecision = "allow" | "deny";

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
  abortListener: () => void;
  signal: AbortSignal;
}

export class ApprovalQueue {
  private readonly pending = new Map<string, PendingEntry>();

  wait(callId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        this.pending.delete(callId);
        reject(new Error(`approval wait aborted for ${callId}`));
      };
      if (signal.aborted) {
        reject(new Error(`approval wait aborted for ${callId}`));
        return;
      }
      signal.addEventListener("abort", abortListener, { once: true });
      this.pending.set(callId, { resolve, reject, abortListener, signal });
    });
  }

  resolve(callId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    this.pending.delete(callId);
    entry.signal.removeEventListener("abort", entry.abortListener);
    entry.resolve(decision);
    return true;
  }
}
```

- [ ] **Step 4: Run, expect 4 PASS** + typecheck

```bash
bun test apps/gateway/src/runtime/approvalQueue.test.ts
bun --filter @vulture/gateway typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): ApprovalQueue with abort-aware wait/resolve"
```

### Task 6: Rust `PolicyEngine::decide_shell_exec`

**Files:**
- Modify: `crates/tool-gateway/src/policy.rs`

- [ ] **Step 1: Add the failing test inside `#[cfg(test)] mod tests`**

Add to `crates/tool-gateway/src/policy.rs` test module:
```rust
#[test]
fn allows_shell_exec_inside_workspace() {
    let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
    let request = ToolRequest {
        run_id: "r1".into(),
        tool: "shell.exec".into(),
        input: serde_json::json!({
            "cwd": "/tmp/vulture-workspace/src",
            "argv": ["echo", "hi"]
        }),
    };
    assert_eq!(engine.decide(&request), PolicyDecision::Allow);
}

#[test]
fn asks_shell_exec_outside_workspace() {
    let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
    let request = ToolRequest {
        run_id: "r1".into(),
        tool: "shell.exec".into(),
        input: serde_json::json!({
            "cwd": "/etc",
            "argv": ["ls"]
        }),
    };
    let decision = engine.decide(&request);
    assert!(matches!(decision, PolicyDecision::Ask { .. }));
}

#[test]
fn asks_shell_exec_with_no_workspace_root() {
    let engine = PolicyEngine::for_workspace("");
    let request = ToolRequest {
        run_id: "r1".into(),
        tool: "shell.exec".into(),
        input: serde_json::json!({
            "cwd": "/tmp",
            "argv": ["ls"]
        }),
    };
    let decision = engine.decide(&request);
    assert!(matches!(decision, PolicyDecision::Ask { .. }));
}

#[test]
fn asks_shell_exec_when_cwd_missing() {
    let engine = PolicyEngine::for_workspace("/tmp/vulture-workspace");
    let request = ToolRequest {
        run_id: "r1".into(),
        tool: "shell.exec".into(),
        input: serde_json::json!({ "argv": ["ls"] }),
    };
    let decision = engine.decide(&request);
    assert!(matches!(decision, PolicyDecision::Ask { .. }));
}
```

- [ ] **Step 2: Run, expect 4 FAIL**

```bash
cargo test -p vulture-tool-gateway policy 2>&1 | grep "test result"
```

- [ ] **Step 3: Replace the `shell.exec` arm in `PolicyEngine::decide`**

Currently in `crates/tool-gateway/src/policy.rs` (around line 26):
```rust
"shell.exec" => PolicyDecision::Ask {
    reason: "shell.exec requires approval".to_string(),
},
```

Replace with:
```rust
"shell.exec" => self.decide_shell_exec(request),
```

Add new private method below `decide_file_read`:
```rust
fn decide_shell_exec(&self, request: &ToolRequest) -> PolicyDecision {
    let Some(cwd) = request.input.get("cwd").and_then(|value| value.as_str()) else {
        return PolicyDecision::Ask {
            reason: "shell.exec missing cwd".to_string(),
        };
    };

    let Some(workspace_root) = self.workspace_root.as_deref() else {
        return PolicyDecision::Ask {
            reason: "shell.exec outside known workspace".to_string(),
        };
    };

    let Some(workspace_root) = normalize_root(workspace_root) else {
        return PolicyDecision::Ask {
            reason: "shell.exec outside known workspace".to_string(),
        };
    };

    if is_inside_root(Path::new(cwd), &workspace_root) {
        PolicyDecision::Allow
    } else {
        PolicyDecision::Ask {
            reason: "shell.exec outside workspace".to_string(),
        }
    }
}
```

- [ ] **Step 4: Run + clippy**

```bash
cargo test -p vulture-tool-gateway 2>&1 | grep "test result"
cargo clippy -p vulture-tool-gateway --all-targets -- -D warnings 2>&1 | tail -3
```

Expect all tests pass; clippy clean.

- [ ] **Step 5: Commit**

```bash
git add crates/tool-gateway
git commit -m "feat(tool-gateway): PolicyEngine allows shell.exec inside workspace"
```

### Task 7: Rust `tool_callback.rs` — accept `approvalToken`

**Files:**
- Modify: `apps/desktop-shell/src/tool_callback.rs`

- [ ] **Step 1: Add the failing test inside `#[cfg(test)] mod tests`**

Add to `apps/desktop-shell/src/tool_callback.rs` test module:
```rust
#[tokio::test]
async fn invoke_with_approval_token_skips_policy_and_executes() {
    let dir = std::env::temp_dir().join(format!("tcb-token-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let audit_path = dir.join("audit.sqlite");
    let token = "x".repeat(43);
    let handle = serve(0, token.clone(), audit_path).await.expect("serve");
    let port = handle.bound_port;

    let res: serde_json::Value = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/tools/invoke"))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({
            "callId": "c1",
            "runId": "r1",
            "tool": "shell.exec",
            "input": { "cwd": std::env::temp_dir().to_string_lossy(), "argv": ["echo", "approved"], "timeoutMs": 5000 },
            "workspacePath": "",
            "approvalToken": "approval-abc"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(res["status"].as_str().unwrap(), "completed");
    assert!(res["output"]["stdout"].as_str().unwrap().contains("approved"));
    handle.shutdown().await;
    std::fs::remove_dir_all(dir).ok();
}
```

- [ ] **Step 2: Run, FAIL** (compile error: `approval_token` field unknown)

- [ ] **Step 3: Add `approval_token` field to `InvokeRequest` and bypass-on-token logic**

In `apps/desktop-shell/src/tool_callback.rs`:

Modify the `InvokeRequest` struct:
```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeRequest {
    call_id: String,
    run_id: String,
    tool: String,
    input: Value,
    workspace_path: String,
    #[serde(default)]
    approval_token: Option<String>,
}
```

Modify `invoke_handler` — at the top, before `state.policy.decide(...)`, add:
```rust
async fn invoke_handler(
    State(state): State<ShellState>,
    Json(req): Json<InvokeRequest>,
) -> impl IntoResponse {
    if let Some(token) = req.approval_token.as_ref() {
        if let Ok(mut store) = state.audit_store.lock() {
            let _ = store.append(
                "tool.approval_used",
                &serde_json::json!({
                    "callId": req.call_id,
                    "runId": req.run_id,
                    "tool": req.tool,
                    "token": token,
                }),
            );
        }
        return execute(&req).await.into_response();
    }
    // ... existing PolicyEngine path unchanged ...
```

- [ ] **Step 4: Run + clippy**

```bash
cargo test -p vulture-desktop-shell tool_callback 2>&1 | grep "test result"
cargo clippy -p vulture-desktop-shell --all-targets -- -D warnings 2>&1 | tail -3
```

Expect 6 tool_callback tests pass (was 5; new test added); clippy clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-shell
git commit -m "feat(shell): tool_callback bypasses policy on approval_token"
```

### Task 8: Gateway `makeShellCallbackTools` rework

**Files:**
- Modify: `apps/gateway/src/server.ts`
- Modify: `apps/gateway/src/runtime/runOrchestrator.ts`
- Modify: `apps/gateway/src/routes/runs.ts` (only the `RunsDeps` interface and orchestrator wiring; the routes change in Task 9)

This task threads the new dependencies (ApprovalQueue + appendEvent closure + cancelSignals) into the tools callable. The approvals route stays as a stub for one more task.

- [ ] **Step 1: Write/extend the failing test in `runs.test.ts`**

Add a test in `apps/gateway/src/routes/runs.test.ts`:
```ts
test("tool callback ask path: emits tool.ask, awaits approval, retries with token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vulture-runs-ask-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const c = convs.create({ agentId: "local-work-agent" });

  // Simulate the shell HTTP server: first call returns "ask", second call (with
  // approvalToken) returns "completed".
  let invokeCount = 0;
  const tokenSeen: string[] = [];
  const fakeShellTools = async (call: {
    callId: string;
    tool: string;
    input: unknown;
    runId: string;
    workspacePath: string;
  }): Promise<unknown> => {
    // This stand-in replaces the real makeShellCallbackTools. Its sole job is
    // to drive the runner-side ToolCallable contract: the runner expects a
    // resolved value or thrown error. The "ask" loop is internal to this fn.
    invokeCount += 1;
    if (invokeCount === 1) {
      // First call: emit tool.ask via runStore (simulating what the production
      // makeShellCallbackTools does), then wait for approval, then re-invoke.
      runs.appendEvent(call.runId, {
        type: "tool.ask",
        callId: call.callId,
        tool: call.tool,
        reason: "test-ask",
        approvalToken: "test-tok",
      });
      const decision = await approvalQueue.wait(call.callId, new AbortController().signal);
      if (decision === "deny") {
        const e = new Error("denied") as Error & { code: string };
        e.code = "tool.permission_denied";
        throw e;
      }
      tokenSeen.push("test-tok");
    }
    return { stdout: "ok" };
  };

  const approvalQueue = new ApprovalQueue();

  const toolLlm: LlmCallable = async function* (): AsyncGenerator<LlmYield, void, unknown> {
    yield { kind: "tool.plan", callId: "c1", tool: "shell.exec", input: { argv: ["x"] } };
    yield { kind: "await.tool", callId: "c1" };
    yield { kind: "final", text: "done" };
  };

  const app = runsRouter({
    conversations: convs,
    messages: msgs,
    runs,
    llm: toolLlm,
    tools: fakeShellTools,
    approvalQueue,
    systemPromptForAgent: () => "system",
    modelForAgent: () => "gpt-5.4",
    workspacePathForAgent: () => "",
  });

  const rRes = await app.request(`/v1/conversations/${c.id}/runs`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ak1" },
    body: JSON.stringify({ input: "test" }),
  });
  const { run } = (await rRes.json()) as { run: { id: string } };

  // wait briefly for tool.ask to be emitted
  await new Promise((r) => setTimeout(r, 100));
  const askEvents = runs.listEventsAfter(run.id, -1).filter((e) => e.type === "tool.ask");
  expect(askEvents.length).toBe(1);

  // approve the call
  approvalQueue.resolve("c1", "allow");

  // poll for terminal
  let final: { status: string } = { status: "running" };
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    const get = await app.request(`/v1/runs/${run.id}`, { headers: auth });
    final = (await get.json()) as { status: string };
    if (["succeeded", "failed", "cancelled"].includes(final.status)) break;
  }
  expect(final.status).toBe("succeeded");
  expect(invokeCount).toBe(2);
  expect(tokenSeen).toEqual(["test-tok"]);

  db.close();
  rmSync(dir, { recursive: true });
});
```

Add `import { ApprovalQueue } from "../runtime/approvalQueue";` at the top of `runs.test.ts`.

- [ ] **Step 2: Run, FAIL** (the test references `approvalQueue` in `runsRouter` deps which doesn't exist yet)

- [ ] **Step 3: Add `approvalQueue` to `RunsDeps` in `apps/gateway/src/routes/runs.ts`**

```ts
import type { ApprovalQueue } from "../runtime/approvalQueue";

export interface RunsDeps {
  conversations: ConversationStore;
  messages: MessageStore;
  runs: RunStore;
  llm: LlmCallable;
  tools: ToolCallable;
  approvalQueue: ApprovalQueue;
  systemPromptForAgent(a: { id: string }): string;
  modelForAgent(a: { id: string }): string;
  workspacePathForAgent(a: { id: string }): string;
}
```

- [ ] **Step 4: Wire `approvalQueue` into `apps/gateway/src/server.ts`**

In `buildServer`:
```ts
import { ApprovalQueue } from "./runtime/approvalQueue";
// ...

const approvalQueue = new ApprovalQueue();
const cancelSignals = new Map<string, AbortController>();

const llm: LlmCallable = makeStubLlm();
const tools: ToolCallable = makeShellCallbackTools({
  callbackUrl: cfg.shellCallbackUrl,
  token: cfg.token,
  appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
  approvalQueue,
  cancelSignals,
});
```

Update `runsRouter({...})` invocation to pass `approvalQueue`.

Update `makeShellCallbackTools` signature:
```ts
function makeShellCallbackTools(opts: {
  callbackUrl: string;
  token: string;
  appendEvent: (runId: string, partial: import("./domain/runStore").PartialRunEvent) => void;
  approvalQueue: ApprovalQueue;
  cancelSignals: Map<string, AbortController>;
}): ToolCallable {
  return async (call) => {
    let approvalToken: string | undefined;
    const ac = opts.cancelSignals.get(call.runId) ?? new AbortController();
    if (!opts.cancelSignals.has(call.runId)) opts.cancelSignals.set(call.runId, ac);

    while (true) {
      const res = await fetch(`${opts.callbackUrl}/tools/invoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
          "X-Caller-Pid": String(process.pid),
        },
        body: JSON.stringify({
          callId: call.callId,
          runId: call.runId,
          tool: call.tool,
          input: call.input,
          workspacePath: call.workspacePath,
          approvalToken,
        }),
      });
      if (!res.ok) throw new ToolCallError("tool.execution_failed", `tool callback HTTP ${res.status}`);
      const body = (await res.json()) as
        | { status: "completed"; callId: string; output: unknown }
        | { status: "failed"; callId: string; error: { code: string; message: string } }
        | { status: "denied"; callId: string; error: { code: string; message: string } }
        | { status: "ask"; callId: string; approvalToken: string; reason: string };

      if (body.status === "completed") return body.output;
      if (body.status === "denied")
        throw new ToolCallError(body.error.code ?? "tool.permission_denied", body.error.message);
      if (body.status === "failed")
        throw new ToolCallError(body.error.code ?? "tool.execution_failed", body.error.message);

      if (body.status === "ask") {
        opts.appendEvent(call.runId, {
          type: "tool.ask",
          callId: call.callId,
          tool: call.tool,
          reason: body.reason,
          approvalToken: body.approvalToken,
        });
        const decision = await opts.approvalQueue.wait(call.callId, ac.signal);
        if (decision === "deny") {
          throw new ToolCallError("tool.permission_denied", `user denied ${call.tool}`);
        }
        approvalToken = body.approvalToken;
        continue;
      }
    }
  };
}
```

`ToolCallError` is already exported from `@vulture/agent-runtime` (added in FU-14).

- [ ] **Step 5: Wire orchestrator + cancel signal**

In `apps/gateway/src/runtime/runOrchestrator.ts`, accept `cancelSignals: Map<string, AbortController>` in `OrchestratorDeps` and create the controller at the start of `orchestrateRun`:

```ts
export interface OrchestratorDeps {
  runs: RunStore;
  messages: MessageStore;
  conversations: ConversationStore;
  llm: LlmCallable;
  tools: ToolCallable;
  cancelSignals: Map<string, AbortController>;
}

export async function orchestrateRun(deps: OrchestratorDeps, args: OrchestrateArgs): Promise<void> {
  const ac = new AbortController();
  deps.cancelSignals.set(args.runId, ac);
  try {
    deps.runs.markRunning(args.runId);
    const result = await runConversation({ /* ... unchanged ... */ });
    // ... existing success/failure logic ...
  } finally {
    deps.cancelSignals.delete(args.runId);
  }
}
```

Update `RunsDeps` and `runsRouter` to accept `cancelSignals` and pass it to `orchestrateRun`.

- [ ] **Step 6: Run + typecheck**

```bash
bun test apps/gateway/src 2>&1 | tail -5
bun --filter @vulture/gateway typecheck 2>&1 | tail -3
```

Expect all tests pass; the new ask-path test passes.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): wire ApprovalQueue + ask-loop in makeShellCallbackTools"
```

### Task 9: Real `POST /v1/runs/:rid/approvals` route

**Files:**
- Modify: `apps/gateway/src/routes/runs.ts`
- Modify: `apps/gateway/src/routes/runs.test.ts`

- [ ] **Step 1: Write failing test**

Append to `apps/gateway/src/routes/runs.test.ts`:
```ts
test("POST /v1/runs/:rid/approvals resolves the queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vulture-runs-approve-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const c = convs.create({ agentId: "local-work-agent" });
  const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
  const run = runs.create({
    conversationId: c.id,
    agentId: c.agentId,
    triggeredByMessageId: userMsg.id,
  });
  const approvalQueue = new ApprovalQueue();
  const ac = new AbortController();
  const waitPromise = approvalQueue.wait("c1", ac.signal);

  const app = runsRouter({
    conversations: convs,
    messages: msgs,
    runs,
    llm: fakeLlm,
    tools: async () => "noop",
    approvalQueue,
    cancelSignals: new Map(),
    systemPromptForAgent: () => "",
    modelForAgent: () => "gpt-5.4",
    workspacePathForAgent: () => "",
  });

  const res = await app.request(`/v1/runs/${run.id}/approvals`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ callId: "c1", decision: "allow" }),
  });
  expect(res.status).toBe(202);
  expect(await waitPromise).toBe("allow");

  db.close();
  rmSync(dir, { recursive: true });
});

test("POST /v1/runs/:rid/approvals with no pending callId returns 404", async () => {
  const { app, c, runs, msgs, cleanup } = fresh();
  const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
  const run = runs.create({
    conversationId: c.id,
    agentId: c.agentId,
    triggeredByMessageId: userMsg.id,
  });
  const res = await app.request(`/v1/runs/${run.id}/approvals`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ callId: "missing", decision: "allow" }),
  });
  expect(res.status).toBe(404);
  cleanup();
});
```

You may need to update the `fresh()` helper to include the new `approvalQueue` and `cancelSignals` deps (with a no-op queue / empty map).

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Replace the stub `/v1/runs/:rid/approvals` handler**

In `apps/gateway/src/routes/runs.ts`:
```ts
import { ApprovalRequestSchema } from "@vulture/protocol/src/v1/approval";

// ...

app.post("/v1/runs/:rid/approvals", async (c) => {
  const rid = c.req.param("rid");
  const run = deps.runs.get(rid);
  if (!run) return c.json({ code: "run.not_found", message: rid }, 404);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = ApprovalRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ code: "internal", message: parsed.error.message }, 400);
  }

  const ok = deps.approvalQueue.resolve(parsed.data.callId, parsed.data.decision);
  if (!ok) {
    return c.json(
      { code: "internal", message: `no pending approval for callId ${parsed.data.callId}` },
      404,
    );
  }
  return c.body(null, 202);
});
```

- [ ] **Step 4: Run + typecheck**

```bash
bun test apps/gateway/src/routes/runs.test.ts 2>&1 | tail -5
bun --filter @vulture/gateway typecheck 2>&1 | tail -3
```

Expect new tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): real POST /v1/runs/:rid/approvals resolves ApprovalQueue"
```

### Task 10: Cancel propagates abort to ApprovalQueue

**Files:**
- Modify: `apps/gateway/src/routes/runs.ts`
- Modify: `apps/gateway/src/routes/runs.test.ts`

- [ ] **Step 1: Write failing test**

Append to `apps/gateway/src/routes/runs.test.ts`:
```ts
test("cancel aborts pending ApprovalQueue waits for the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vulture-runs-cancel-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const c = convs.create({ agentId: "local-work-agent" });
  const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
  const run = runs.create({
    conversationId: c.id,
    agentId: c.agentId,
    triggeredByMessageId: userMsg.id,
  });
  runs.markRunning(run.id);

  const approvalQueue = new ApprovalQueue();
  const cancelSignals = new Map<string, AbortController>();
  const ac = new AbortController();
  cancelSignals.set(run.id, ac);
  const waitPromise = approvalQueue.wait("c1", ac.signal);

  const app = runsRouter({
    conversations: convs,
    messages: msgs,
    runs,
    llm: fakeLlm,
    tools: async () => "noop",
    approvalQueue,
    cancelSignals,
    systemPromptForAgent: () => "",
    modelForAgent: () => "gpt-5.4",
    workspacePathForAgent: () => "",
  });

  const res = await app.request(`/v1/runs/${run.id}/cancel`, {
    method: "POST",
    headers: auth,
  });
  expect(res.status).toBe(202);
  await expect(waitPromise).rejects.toThrow(/aborted/);

  db.close();
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Wire cancel → AbortController.abort()**

In `apps/gateway/src/routes/runs.ts`, modify the cancel route:
```ts
app.post("/v1/runs/:rid/cancel", (c) => {
  const rid = c.req.param("rid");
  const run = deps.runs.get(rid);
  if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
  if (["succeeded", "failed", "cancelled"].includes(run.status)) {
    return c.json({ code: "run.already_completed", message: run.status }, 409);
  }
  // Abort pending ApprovalQueue waits for this run
  deps.cancelSignals.get(rid)?.abort();
  deps.runs.markCancelled(rid);
  deps.runs.appendEvent(rid, { type: "run.cancelled" });
  return c.json(deps.runs.get(rid), 202);
});
```

- [ ] **Step 4: Run + typecheck**

```bash
bun test apps/gateway/src 2>&1 | tail -5
bun --filter @vulture/gateway typecheck 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): cancel run aborts pending approvals"
```

---

## Group D — Real LLM via @openai/agents

### Task 11: `runtime/openaiLlm.ts`

**Files:**
- Create: `apps/gateway/src/runtime/openaiLlm.ts`
- Create: `apps/gateway/src/runtime/openaiLlm.test.ts`

The translation table from `@openai/agents` Run events to our `LlmYield` is:

| SDK event | LlmYield |
|---|---|
| `text.delta` (assistant text token) | `{ kind: "text.delta", text }` |
| `tool_call.created` (model wants to call a tool) | `{ kind: "tool.plan", callId, tool, input }` |
| `tool_call.executing` (SDK about to run tool) | `{ kind: "await.tool", callId }` |
| (after tool result returned to SDK) | next iteration of LLM stream |
| `text.completed` / final response | `{ kind: "final", text: assembledText }` |

**IMPORTANT:** The `@openai/agents` API surface evolves. The actual event names and shapes must be verified at implementation time via `bun add @openai/agents` (already a dep) + reading the package exports. The test below uses a thin wrapper around the SDK so that mocking is straightforward; if the API differs from this assumption, adapt the wrapper signature without changing the public `LlmCallable` contract.

- [ ] **Step 1: Write the failing test**

`apps/gateway/src/runtime/openaiLlm.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  makeOpenAILlm,
  makeStubLlmFallback,
  type SdkRunEvent,
} from "./openaiLlm";
import type { LlmYield } from "@vulture/agent-runtime";

describe("makeOpenAILlm", () => {
  test("translates SDK text.delta and final events into LlmYield", async () => {
    const sdkEvents: SdkRunEvent[] = [
      { kind: "text.delta", text: "Hello, " },
      { kind: "text.delta", text: "world." },
      { kind: "final", text: "Hello, world." },
    ];
    const llm = makeOpenAILlm({
      apiKey: "sk-test",
      toolNames: ["shell.exec"],
      runFactory: () => makeMockRun(sdkEvents),
    });
    const yields: LlmYield[] = [];
    for await (const y of llm({ systemPrompt: "x", userInput: "hi", model: "gpt-5.4" })) {
      yields.push(y);
    }
    expect(yields.map((y) => y.kind)).toEqual(["text.delta", "text.delta", "final"]);
  });

  test("translates SDK tool_call events into tool.plan + await.tool", async () => {
    const sdkEvents: SdkRunEvent[] = [
      { kind: "tool.plan", callId: "c1", tool: "shell.exec", input: { argv: ["ls"] } },
      { kind: "await.tool", callId: "c1" },
      { kind: "final", text: "done" },
    ];
    const llm = makeOpenAILlm({
      apiKey: "sk-test",
      toolNames: ["shell.exec"],
      runFactory: () => makeMockRun(sdkEvents),
    });
    const yields: LlmYield[] = [];
    for await (const y of llm({ systemPrompt: "x", userInput: "hi", model: "gpt-5.4" })) {
      yields.push(y);
    }
    expect(yields.map((y) => y.kind)).toEqual(["tool.plan", "await.tool", "final"]);
    expect(yields[0]).toMatchObject({ tool: "shell.exec" });
  });
});

describe("makeStubLlmFallback", () => {
  test("yields a single configuration-needed final message", async () => {
    const llm = makeStubLlmFallback();
    const yields: LlmYield[] = [];
    for await (const y of llm({ systemPrompt: "x", userInput: "hi", model: "gpt-5.4" })) {
      yields.push(y);
    }
    expect(yields).toHaveLength(1);
    expect(yields[0].kind).toBe("final");
    if (yields[0].kind === "final") {
      expect(yields[0].text).toContain("OPENAI_API_KEY");
    }
  });
});

async function* makeMockRun(events: SdkRunEvent[]) {
  for (const e of events) yield e;
}
```

- [ ] **Step 2: Run, FAIL**: `bun test apps/gateway/src/runtime/openaiLlm.test.ts`

- [ ] **Step 3: Write `apps/gateway/src/runtime/openaiLlm.ts`**

```ts
import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";
import { selectModel } from "@vulture/llm";

export type SdkRunEvent =
  | { kind: "text.delta"; text: string }
  | { kind: "tool.plan"; callId: string; tool: string; input: unknown }
  | { kind: "await.tool"; callId: string }
  | { kind: "final"; text: string };

export interface OpenAILlmOptions {
  apiKey: string;
  toolNames: readonly string[];
  /**
   * Factory that returns an async iterable of SDK events for one run. Default
   * uses the real @openai/agents Run; tests inject a deterministic stream.
   */
  runFactory?: (input: {
    systemPrompt: string;
    userInput: string;
    model: string;
    apiKey: string;
    toolNames: readonly string[];
  }) => AsyncIterable<SdkRunEvent>;
}

export function makeOpenAILlm(opts: OpenAILlmOptions): LlmCallable {
  const factory = opts.runFactory ?? defaultRunFactory;
  return async function* (input): AsyncGenerator<LlmYield, void, unknown> {
    const stream = factory({
      systemPrompt: input.systemPrompt,
      userInput: input.userInput,
      model: selectModel(input.model),
      apiKey: opts.apiKey,
      toolNames: opts.toolNames,
    });
    for await (const event of stream) {
      yield event as LlmYield;
    }
  };
}

export function makeStubLlmFallback(): LlmCallable {
  return async function* (): AsyncGenerator<LlmYield, void, unknown> {
    yield {
      kind: "final",
      text:
        "OPENAI_API_KEY not configured. Set the key via Settings or set the env var, then retry.",
    };
  };
}

async function* defaultRunFactory(input: {
  systemPrompt: string;
  userInput: string;
  model: string;
  apiKey: string;
  toolNames: readonly string[];
}): AsyncIterable<SdkRunEvent> {
  // The @openai/agents SDK's Run streaming API. The exact import + event shape
  // must be verified at implementation time. This stub raises so the implementer
  // is forced to wire the real translation.
  throw new Error(
    `defaultRunFactory not implemented. Wire @openai/agents Run here. (model=${input.model}, tools=${input.toolNames.join(",")})`,
  );
}
```

NOTE on `defaultRunFactory`: this task ships the `LlmCallable` shape and the test-only `runFactory` injection. The actual `@openai/agents` SDK call is plumbed in Task 12 once the SDK API surface is verified hands-on. This keeps Task 11 testable purely with a mock factory.

- [ ] **Step 4: Run, expect 3 PASS** + typecheck

```bash
bun test apps/gateway/src/runtime/openaiLlm.test.ts
bun --filter @vulture/gateway typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): openaiLlm wrapper + stub fallback (factory injection for tests)"
```

### Task 12: Wire real `@openai/agents` and conditional LLM selection

**Files:**
- Modify: `apps/gateway/src/runtime/openaiLlm.ts` — replace `defaultRunFactory` with real SDK call
- Modify: `apps/gateway/src/server.ts`

This task does the actual SDK integration. The shape of the `@openai/agents` API must be verified by reading the installed package's exports first. The implementer should:

- [ ] **Step 1: Verify SDK shape**

```bash
ls node_modules/.bun/@openai+agents@*/node_modules/@openai/agents/dist/*.d.ts | head -5
grep -E "^export (class|function|const|type|interface) " node_modules/.bun/@openai+agents@*/node_modules/@openai/agents/dist/index.d.ts 2>/dev/null | head -30
```

Expected: Some flavor of `Agent` class + `run()` function (or similar). The exact import names + streaming event shape vary. **Adapt the implementation below** to the actual SDK; the test contract from Task 11 (`SdkRunEvent` enum) is the stable boundary.

- [ ] **Step 2: Replace `defaultRunFactory` in `openaiLlm.ts`**

Pseudo-implementation (adapt to real SDK):
```ts
async function* defaultRunFactory(input: {
  systemPrompt: string;
  userInput: string;
  model: string;
  apiKey: string;
  toolNames: readonly string[];
}): AsyncIterable<SdkRunEvent> {
  // 1. Construct an Agent with system prompt + tool stubs (zod schemas matching
  //    Rust ShellExecInput / browser tool inputs). Tool execute callbacks throw
  //    a sentinel that the runner-side ToolCallable intercepts via the LlmYield
  //    "await.tool" path. (Or: the SDK supports yielding tool_call events
  //    without executing — preferred, then runner handles execution.)
  // 2. Invoke `run(agent, userInput, { stream: true, apiKey })` (or the SDK's
  //    actual streaming entry point).
  // 3. For each SDK event, translate to SdkRunEvent and yield. Accumulate
  //    final text.
  //
  // If the SDK doesn't expose tool_call events to the host, the runner cannot
  // intercept tool execution. In that case, the SDK must be configured to
  // surface tool intentions before execution (look for `requireApproval` /
  // `tools_choice: required` in the SDK docs). If the SDK has no such hook,
  // raise this as a BLOCKED escalation — Phase 3b's design depends on it.
  throw new Error("OpenAI Agents SDK integration TBD; see Task 12 of the 3b plan");
}
```

The implementer may need 1–2 hours of SDK exploration. If the SDK shape doesn't accommodate the ToolCallable intercept pattern, escalate as `BLOCKED`; we revise the design to use a different LLM library (e.g., OpenAI Node SDK directly + custom streaming) before continuing.

- [ ] **Step 3: Add a smoke test (skipped by default; runs only with real key)**

In `apps/gateway/src/runtime/openaiLlm.smoke.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { makeOpenAILlm } from "./openaiLlm";

const SKIP = !process.env.OPENAI_API_KEY;

describe.skipIf(SKIP)("openaiLlm smoke", () => {
  test("real API call yields at least one text.delta + final", async () => {
    const llm = makeOpenAILlm({
      apiKey: process.env.OPENAI_API_KEY!,
      toolNames: [],
    });
    const kinds: string[] = [];
    for await (const y of llm({
      systemPrompt: "Reply with a single word.",
      userInput: "hi",
      model: "gpt-4o-mini",
    })) {
      kinds.push(y.kind);
    }
    expect(kinds).toContain("final");
  }, 30_000);
});
```

CI does not have `OPENAI_API_KEY` set, so the suite is skipped. Locally, run with `OPENAI_API_KEY=sk-... bun test apps/gateway/src/runtime/openaiLlm.smoke.test.ts`.

- [ ] **Step 4: Wire conditional selection in `apps/gateway/src/server.ts`**

```ts
import { isApiKeyConfigured } from "@vulture/llm";
import { makeOpenAILlm, makeStubLlmFallback } from "./runtime/openaiLlm";
import { AGENT_TOOL_NAMES } from "@vulture/protocol/src/v1/agent";

// inside buildServer, replacing the current makeStubLlm() construction:
const llm: LlmCallable = isApiKeyConfigured(process.env)
  ? makeOpenAILlm({
      apiKey: process.env.OPENAI_API_KEY!,
      toolNames: AGENT_TOOL_NAMES,
    })
  : makeStubLlmFallback();
```

Drop the now-unused inline `makeStubLlm` function in server.ts.

- [ ] **Step 5: Run + typecheck**

```bash
bun test apps/gateway/src 2>&1 | tail -5
bun --filter @vulture/gateway typecheck 2>&1 | tail -3
cargo test --workspace 2>&1 | grep "^test result" | head -3
```

The integration tests in `runs.integration.test.ts` exercise the stub fallback path (no env var); behavior unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): @openai/agents real LLM with stub fallback when key missing"
```

---

## Group E — UI hooks (M4)

### Task 13: `hooks/useConversations.ts`

**Files:**
- Create: `apps/desktop-ui/src/hooks/useConversations.ts`
- Create: `apps/desktop-ui/src/hooks/useConversations.test.ts`

The hook itself wraps a reducer; the reducer is pure and trivially testable. The React rendering surface is exercised in Task 24's integration test.

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/hooks/useConversations.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import {
  conversationsReducer,
  type ConversationsState,
} from "./useConversations";
import type { ConversationDto } from "../api/conversations";

const a: ConversationDto = {
  id: "c-a",
  agentId: "agent",
  title: "A",
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
};
const b: ConversationDto = { ...a, id: "c-b", title: "B" };

const initial: ConversationsState = { items: [], loading: false, error: null };

describe("conversationsReducer", () => {
  test("loading -> success replaces items", () => {
    const s1 = conversationsReducer(initial, { type: "load.start" });
    expect(s1.loading).toBe(true);
    const s2 = conversationsReducer(s1, { type: "load.success", items: [a, b] });
    expect(s2.items).toEqual([a, b]);
    expect(s2.loading).toBe(false);
  });

  test("create.optimistic prepends item", () => {
    const s = conversationsReducer({ ...initial, items: [a] }, { type: "create.optimistic", item: b });
    expect(s.items.map((x) => x.id)).toEqual(["c-b", "c-a"]);
  });

  test("create.commit replaces optimistic by id", () => {
    const optimistic: ConversationDto = { ...b, title: "(temp)" };
    const real: ConversationDto = { ...b, title: "(real)" };
    const s1 = conversationsReducer(initial, { type: "create.optimistic", item: optimistic });
    const s2 = conversationsReducer(s1, { type: "create.commit", id: optimistic.id, item: real });
    expect(s2.items).toEqual([real]);
  });

  test("delete removes by id", () => {
    const s = conversationsReducer({ ...initial, items: [a, b] }, { type: "delete", id: a.id });
    expect(s.items).toEqual([b]);
  });

  test("load.error sets error", () => {
    const s = conversationsReducer(initial, { type: "load.error", error: "boom" });
    expect(s.error).toBe("boom");
    expect(s.loading).toBe(false);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/hooks/useConversations.ts`**

```ts
import { useCallback, useEffect, useReducer } from "react";
import type { ApiClient } from "../api/client";
import {
  conversationsApi,
  type ConversationDto,
  type CreateConversationRequest,
} from "../api/conversations";

export interface ConversationsState {
  items: ConversationDto[];
  loading: boolean;
  error: string | null;
}

export type ConversationsAction =
  | { type: "load.start" }
  | { type: "load.success"; items: ConversationDto[] }
  | { type: "load.error"; error: string }
  | { type: "create.optimistic"; item: ConversationDto }
  | { type: "create.commit"; id: string; item: ConversationDto }
  | { type: "create.rollback"; id: string }
  | { type: "delete"; id: string };

export function conversationsReducer(
  state: ConversationsState,
  action: ConversationsAction,
): ConversationsState {
  switch (action.type) {
    case "load.start":
      return { ...state, loading: true, error: null };
    case "load.success":
      return { items: action.items, loading: false, error: null };
    case "load.error":
      return { ...state, loading: false, error: action.error };
    case "create.optimistic":
      return { ...state, items: [action.item, ...state.items] };
    case "create.commit":
      return {
        ...state,
        items: state.items.map((x) => (x.id === action.id ? action.item : x)),
      };
    case "create.rollback":
      return { ...state, items: state.items.filter((x) => x.id !== action.id) };
    case "delete":
      return { ...state, items: state.items.filter((x) => x.id !== action.id) };
  }
}

export function useConversations(client: ApiClient | null) {
  const [state, dispatch] = useReducer(conversationsReducer, {
    items: [],
    loading: false,
    error: null,
  });

  const refetch = useCallback(async () => {
    if (!client) return;
    dispatch({ type: "load.start" });
    try {
      const items = await conversationsApi.list(client);
      dispatch({ type: "load.success", items });
    } catch (cause) {
      dispatch({
        type: "load.error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [client]);

  const create = useCallback(
    async (req: CreateConversationRequest) => {
      if (!client) throw new Error("client not ready");
      const tempId = `c-temp-${crypto.randomUUID()}`;
      const optimistic: ConversationDto = {
        id: tempId,
        agentId: req.agentId,
        title: req.title ?? "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      dispatch({ type: "create.optimistic", item: optimistic });
      try {
        const real = await conversationsApi.create(client, req);
        dispatch({ type: "create.commit", id: tempId, item: real });
        return real;
      } catch (cause) {
        dispatch({ type: "create.rollback", id: tempId });
        throw cause;
      }
    },
    [client],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!client) return;
      dispatch({ type: "delete", id });
      try {
        await conversationsApi.delete(client, id);
      } catch (cause) {
        // re-fetch on error to reconcile
        void refetch();
        throw cause;
      }
    },
    [client, refetch],
  );

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { ...state, refetch, create, remove };
}
```

- [ ] **Step 4: Run, expect 5 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): useConversations hook + reducer"
```

### Task 14: `hooks/useMessages.ts`

**Files:**
- Create: `apps/desktop-ui/src/hooks/useMessages.ts`
- Create: `apps/desktop-ui/src/hooks/useMessages.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/hooks/useMessages.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { messagesReducer, type MessagesState } from "./useMessages";
import type { MessageDto } from "../api/conversations";

const m1: MessageDto = {
  id: "m-1",
  conversationId: "c-1",
  role: "user",
  content: "hi",
  runId: null,
  createdAt: "2026-04-27T00:00:00.000Z",
};
const m2: MessageDto = { ...m1, id: "m-2", role: "assistant", content: "yo" };

const initial: MessagesState = { items: [], loading: false, error: null };

describe("messagesReducer", () => {
  test("load.success replaces items", () => {
    const s = messagesReducer(initial, { type: "load.success", items: [m1, m2] });
    expect(s.items).toEqual([m1, m2]);
  });

  test("append adds without duplicating", () => {
    const s1 = messagesReducer({ ...initial, items: [m1] }, { type: "append", item: m2 });
    expect(s1.items).toEqual([m1, m2]);
    const s2 = messagesReducer(s1, { type: "append", item: m2 });
    expect(s2.items).toEqual([m1, m2]);
  });

  test("clear empties items", () => {
    const s = messagesReducer({ ...initial, items: [m1, m2] }, { type: "clear" });
    expect(s.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/hooks/useMessages.ts`**

```ts
import { useCallback, useEffect, useReducer } from "react";
import type { ApiClient } from "../api/client";
import { conversationsApi, type MessageDto } from "../api/conversations";

export interface MessagesState {
  items: MessageDto[];
  loading: boolean;
  error: string | null;
}

export type MessagesAction =
  | { type: "load.start" }
  | { type: "load.success"; items: MessageDto[] }
  | { type: "load.error"; error: string }
  | { type: "append"; item: MessageDto }
  | { type: "clear" };

export function messagesReducer(state: MessagesState, action: MessagesAction): MessagesState {
  switch (action.type) {
    case "load.start":
      return { ...state, loading: true, error: null };
    case "load.success":
      return { items: action.items, loading: false, error: null };
    case "load.error":
      return { ...state, loading: false, error: action.error };
    case "append":
      if (state.items.some((m) => m.id === action.item.id)) return state;
      return { ...state, items: [...state.items, action.item] };
    case "clear":
      return { items: [], loading: false, error: null };
  }
}

export function useMessages(client: ApiClient | null, conversationId: string | null) {
  const [state, dispatch] = useReducer(messagesReducer, {
    items: [],
    loading: false,
    error: null,
  });

  const refetch = useCallback(async () => {
    if (!client || !conversationId) {
      dispatch({ type: "clear" });
      return;
    }
    dispatch({ type: "load.start" });
    try {
      const items = await conversationsApi.listMessages(client, conversationId);
      dispatch({ type: "load.success", items });
    } catch (cause) {
      dispatch({
        type: "load.error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [client, conversationId]);

  const append = useCallback((item: MessageDto) => {
    dispatch({ type: "append", item });
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { ...state, refetch, append };
}
```

- [ ] **Step 4: Run, expect 3 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): useMessages hook + reducer"
```

### Task 15: `hooks/useRunStream.ts` — SSE consumer with reconnect

**Files:**
- Create: `apps/desktop-ui/src/hooks/useRunStream.ts`
- Create: `apps/desktop-ui/src/hooks/useRunStream.test.ts`

The hook is the most complex piece in M4. The reconnect machinery is extracted as a pure reducer + a runner; both are tested independently.

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/hooks/useRunStream.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { runStreamReducer, type RunStreamState } from "./useRunStream";

type Event =
  | { type: "run.started"; runId: string; seq: number; createdAt: string; agentId: string; model: string }
  | { type: "text.delta"; runId: string; seq: number; createdAt: string; text: string }
  | { type: "run.completed"; runId: string; seq: number; createdAt: string; resultMessageId: string; finalText: string };

const initial: RunStreamState = { status: "idle", events: [], lastSeq: -1, error: null };

describe("runStreamReducer", () => {
  test("connect.start -> connecting", () => {
    const s = runStreamReducer(initial, { type: "connect.start" });
    expect(s.status).toBe("connecting");
  });

  test("frame appends event and tracks seq", () => {
    const ev: Event = {
      type: "run.started",
      runId: "r",
      seq: 0,
      createdAt: "2026-04-27T00:00:00.000Z",
      agentId: "a",
      model: "gpt-5.4",
    };
    const s = runStreamReducer(
      { ...initial, status: "streaming" },
      { type: "frame", event: ev as never },
    );
    expect(s.events).toHaveLength(1);
    expect(s.lastSeq).toBe(0);
  });

  test("frame with seq <= lastSeq is dropped (replay safety)", () => {
    const evA: Event = {
      type: "run.started",
      runId: "r",
      seq: 5,
      createdAt: "2026-04-27T00:00:00.000Z",
      agentId: "a",
      model: "gpt-5.4",
    };
    const evB: Event = {
      type: "text.delta",
      runId: "r",
      seq: 5,
      createdAt: "2026-04-27T00:00:00.000Z",
      text: "x",
    };
    const s1 = runStreamReducer({ ...initial, status: "streaming" }, { type: "frame", event: evA as never });
    const s2 = runStreamReducer(s1, { type: "frame", event: evB as never });
    expect(s2.events).toHaveLength(1);
    expect(s2.lastSeq).toBe(5);
  });

  test("error -> reconnecting; status terminal stays terminal", () => {
    const s1 = runStreamReducer(
      { ...initial, status: "streaming" },
      { type: "error", error: "boom" },
    );
    expect(s1.status).toBe("reconnecting");
    expect(s1.error).toBe("boom");

    const completed: RunStreamState = {
      status: "succeeded",
      events: [],
      lastSeq: 3,
      error: null,
    };
    const s2 = runStreamReducer(completed, { type: "error", error: "late" });
    expect(s2.status).toBe("succeeded"); // already terminal
  });

  test("terminal event flips status", () => {
    const ev: Event = {
      type: "run.completed",
      runId: "r",
      seq: 9,
      createdAt: "2026-04-27T00:00:00.000Z",
      resultMessageId: "m-r",
      finalText: "done",
    };
    const s = runStreamReducer(
      { ...initial, status: "streaming" },
      { type: "frame", event: ev as never },
    );
    expect(s.status).toBe("succeeded");
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/hooks/useRunStream.ts`**

```ts
import { useEffect, useReducer, useRef } from "react";
import type { ApiClient } from "../api/client";
import { sseStream } from "../api/sse";

// We keep RunEvent permissive here (`any` shape) to avoid a hard import on the
// protocol package's discriminated union — the reducer treats events as opaque
// blobs apart from `seq` + `type`. UI components type-narrow at the rendering
// boundary.
export type AnyRunEvent = {
  type: string;
  runId: string;
  seq: number;
  createdAt: string;
  [key: string]: unknown;
};

export type RunStreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunStreamState {
  status: RunStreamStatus;
  events: AnyRunEvent[];
  lastSeq: number;
  error: string | null;
}

export type RunStreamAction =
  | { type: "connect.start" }
  | { type: "connect.success" }
  | { type: "frame"; event: AnyRunEvent }
  | { type: "error"; error: string }
  | { type: "abort" };

const TERMINAL: RunStreamStatus[] = ["succeeded", "failed", "cancelled"];

function isTerminal(s: RunStreamStatus): boolean {
  return TERMINAL.includes(s);
}

export function runStreamReducer(state: RunStreamState, action: RunStreamAction): RunStreamState {
  switch (action.type) {
    case "connect.start":
      return { ...state, status: "connecting", error: null };
    case "connect.success":
      return { ...state, status: "streaming", error: null };
    case "frame": {
      if (isTerminal(state.status)) return state;
      if (action.event.seq <= state.lastSeq) return state;
      const events = [...state.events, action.event];
      let status: RunStreamStatus = "streaming";
      if (action.event.type === "run.completed") status = "succeeded";
      else if (action.event.type === "run.failed") status = "failed";
      else if (action.event.type === "run.cancelled") status = "cancelled";
      return { ...state, events, lastSeq: action.event.seq, status };
    }
    case "error":
      if (isTerminal(state.status)) return state;
      return { ...state, status: "reconnecting", error: action.error };
    case "abort":
      return { ...state, status: "cancelled" };
  }
}

export interface UseRunStreamOptions {
  client: ApiClient | null;
  runId: string | null;
  fetch?: typeof fetch;
}

export function useRunStream(opts: UseRunStreamOptions): RunStreamState {
  const [state, dispatch] = useReducer(runStreamReducer, {
    status: "idle",
    events: [],
    lastSeq: -1,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!opts.client || !opts.runId) return;
    const ac = new AbortController();
    let retry = 0;

    async function loop() {
      while (!ac.signal.aborted && !isTerminal(stateRef.current.status)) {
        dispatch({ type: "connect.start" });
        try {
          const url = `${opts.client!.base ?? ""}/v1/runs/${opts.runId}/events`;
          // ApiClient currently doesn't expose its base URL; we recreate the
          // header set here. See note below for a small ApiClient extension.
          for await (const frame of sseStream({
            url,
            token: opts.client!.token,
            lastEventId:
              stateRef.current.lastSeq >= 0 ? String(stateRef.current.lastSeq) : undefined,
            signal: ac.signal,
            fetch: opts.fetch,
          })) {
            if (retry === 0) dispatch({ type: "connect.success" });
            retry = 0;
            const parsed = JSON.parse(frame.data) as AnyRunEvent;
            dispatch({ type: "frame", event: parsed });
            if (isTerminal(stateRef.current.status)) return;
          }
          // stream ended cleanly without terminal event
          if (!isTerminal(stateRef.current.status)) {
            dispatch({ type: "error", error: "stream ended unexpectedly" });
          }
        } catch (cause) {
          if (ac.signal.aborted) return;
          dispatch({
            type: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          });
          retry += 1;
          const backoff = Math.min(16_000, 1000 * 2 ** Math.min(retry, 4));
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    void loop();
    return () => ac.abort();
  }, [opts.client, opts.runId, opts.fetch]);

  return state;
}
```

NOTE on ApiClient extension: the hook needs `client.base` and `client.token` to construct the SSE URL + auth header. Extend `apps/desktop-ui/src/api/client.ts`:

```ts
export interface ApiClient {
  // ... existing methods ...
  readonly base: string;
  readonly token: string;
}
```

In `createApiClient`, add `base: \`http://${host}:${rt.gateway.port}\`` and `token: rt.token` to the returned object. This is a tiny additive change; existing tests still pass.

- [ ] **Step 4: Run, expect 5 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): useRunStream hook with reconnect + Last-Event-ID; expose ApiClient.base/token"
```

### Task 16: `hooks/useApproval.ts`

**Files:**
- Create: `apps/desktop-ui/src/hooks/useApproval.ts`
- Create: `apps/desktop-ui/src/hooks/useApproval.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/hooks/useApproval.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { extractPendingApprovals } from "./useApproval";
import type { AnyRunEvent } from "./useRunStream";

const ask = (callId: string, seq: number): AnyRunEvent => ({
  type: "tool.ask",
  runId: "r",
  seq,
  createdAt: "2026-04-27T00:00:00.000Z",
  callId,
  tool: "shell.exec",
  reason: "test",
  approvalToken: `tok-${callId}`,
});
const completed = (callId: string, seq: number): AnyRunEvent => ({
  type: "tool.completed",
  runId: "r",
  seq,
  createdAt: "2026-04-27T00:00:00.000Z",
  callId,
  output: {},
});
const failed = (callId: string, seq: number): AnyRunEvent => ({
  type: "tool.failed",
  runId: "r",
  seq,
  createdAt: "2026-04-27T00:00:00.000Z",
  callId,
  error: { code: "x", message: "y" },
});

describe("extractPendingApprovals", () => {
  test("returns asks not yet superseded", () => {
    const events = [ask("a", 1), ask("b", 2)];
    expect(extractPendingApprovals(events).map((p) => p.callId)).toEqual(["a", "b"]);
  });

  test("ask superseded by completed/failed is dropped", () => {
    const events = [ask("a", 1), completed("a", 5), ask("b", 2)];
    expect(extractPendingApprovals(events).map((p) => p.callId)).toEqual(["b"]);
  });

  test("ask superseded by tool.failed is dropped", () => {
    const events = [ask("a", 1), failed("a", 6)];
    expect(extractPendingApprovals(events)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/hooks/useApproval.ts`**

```ts
import { useCallback, useMemo, useState } from "react";
import type { ApiClient } from "../api/client";
import { runsApi, type ApprovalDecision } from "../api/runs";
import type { AnyRunEvent } from "./useRunStream";

export interface PendingApproval {
  callId: string;
  tool: string;
  reason: string;
  approvalToken: string;
  seq: number;
}

export function extractPendingApprovals(events: readonly AnyRunEvent[]): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  for (const e of events) {
    if (e.type === "tool.ask") {
      pending.set(String(e.callId), {
        callId: String(e.callId),
        tool: String(e.tool ?? ""),
        reason: String(e.reason ?? ""),
        approvalToken: String(e.approvalToken ?? ""),
        seq: e.seq,
      });
    } else if (
      (e.type === "tool.completed" || e.type === "tool.failed" || e.type === "run.cancelled") &&
      e.callId !== undefined
    ) {
      pending.delete(String(e.callId));
    } else if (e.type === "run.cancelled") {
      pending.clear();
    }
  }
  return [...pending.values()];
}

export interface UseApprovalOptions {
  client: ApiClient | null;
  runId: string | null;
  events: readonly AnyRunEvent[];
}

export function useApproval(opts: UseApprovalOptions) {
  const [submitting, setSubmitting] = useState<Set<string>>(new Set());
  const pending = useMemo(() => extractPendingApprovals(opts.events), [opts.events]);

  const decide = useCallback(
    async (callId: string, decision: ApprovalDecision) => {
      if (!opts.client || !opts.runId) return;
      setSubmitting((prev) => new Set(prev).add(callId));
      try {
        await runsApi.approve(opts.client, opts.runId, { callId, decision });
      } finally {
        setSubmitting((prev) => {
          const next = new Set(prev);
          next.delete(callId);
          return next;
        });
      }
    },
    [opts.client, opts.runId],
  );

  return { pending, submitting, decide };
}
```

- [ ] **Step 4: Run, expect 3 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): useApproval hook + extractPendingApprovals"
```

---

## Group F — UI components (M5)

### Task 17: M5 prep — `bunfig.toml` + happy-dom + testing-library

**Files:**
- Modify: `bunfig.toml`
- Modify: `apps/desktop-ui/package.json`

This task adds React component test infrastructure. Each subsequent component task gets a render smoke test.

- [ ] **Step 1: Add devDeps**

Edit `apps/desktop-ui/package.json` to add to `devDependencies`:
```json
"@testing-library/react": "^16.0.0",
"@testing-library/dom": "^10.0.0",
"@happy-dom/global-registrator": "^15.0.0"
```

Run:
```bash
bun install
```

- [ ] **Step 2: Configure bun test preload**

Edit `bunfig.toml`:
```toml
[install]
exact = false

[test]
preload = ["./scripts/test-setup.ts"]
```

Create `scripts/test-setup.ts`:
```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { document?: unknown }).document) {
  GlobalRegistrator.register();
}
```

This makes `document` / `window` available to React components in `bun test`. The guard prevents double-registration when running individual files.

- [ ] **Step 3: Verify with a tiny smoke test**

Create `apps/desktop-ui/src/chat/_smoke.test.tsx`:
```tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";

describe("dom available", () => {
  test("renders a paragraph", () => {
    render(<p>hello</p>);
    expect(screen.getByText("hello")).toBeDefined();
  });
});
```

Run:
```bash
bun test apps/desktop-ui/src/chat/_smoke.test.tsx
```

Expect 1 pass.

- [ ] **Step 4: Verify existing tests still pass**

```bash
bun test 2>&1 | tail -5
bun --filter @vulture/desktop-ui typecheck 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui bunfig.toml scripts/test-setup.ts package.json bun.lock
git commit -m "chore(ui): add happy-dom + testing-library for component tests"
```

(Delete `_smoke.test.tsx` if you prefer; the dep verification carries forward through subsequent component tests.)

### Task 18: `chat/MessageBubble.tsx`

**Files:**
- Create: `apps/desktop-ui/src/chat/MessageBubble.tsx`
- Create: `apps/desktop-ui/src/chat/MessageBubble.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/chat/MessageBubble.test.tsx`:
```tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble", () => {
  test("renders user role with content", () => {
    render(<MessageBubble role="user" content="hello world" />);
    expect(screen.getByText("hello world")).toBeDefined();
  });

  test("applies role class for assistant", () => {
    const { container } = render(<MessageBubble role="assistant" content="hi" />);
    const article = container.querySelector("article")!;
    expect(article.className).toContain("assistant");
  });

  test("renders system role with muted variant", () => {
    const { container } = render(<MessageBubble role="system" content="info" />);
    expect(container.querySelector("article")!.className).toContain("system");
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/chat/MessageBubble.tsx`**

```tsx
export interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const avatar = role === "user" ? "J" : "V";
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar">{avatar}</div>
      <div className="message-bubble">
        <pre>{content}</pre>
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Run, expect 3 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): MessageBubble component"
```

### Task 19: `chat/ToolBlock.tsx`

**Files:**
- Create: `apps/desktop-ui/src/chat/ToolBlock.tsx`
- Create: `apps/desktop-ui/src/chat/ToolBlock.test.tsx`

ToolBlock implements the smart expand/collapse behavior chosen in Q5:
- `running` → auto-expanded
- `completed` (success) → collapsed (one-line)
- `failed` → auto-expanded with error
- Click title → toggle

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/chat/ToolBlock.test.tsx`:
```tsx
import { describe, expect, test } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolBlock } from "./ToolBlock";

describe("ToolBlock", () => {
  test("running state renders expanded with input", () => {
    render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="running"
      />,
    );
    expect(screen.getByText("shell.exec")).toBeDefined();
    expect(screen.getByText(/ls/)).toBeDefined();
    expect(screen.getByText("运行中")).toBeDefined();
  });

  test("completed (success) renders collapsed by default", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="completed"
        output={{ stdout: "src/" }}
      />,
    );
    // collapsed = no output visible until clicked
    expect(container.textContent).not.toContain("src/");
  });

  test("clicking title toggles expansion", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="completed"
        output={{ stdout: "src/" }}
      />,
    );
    const header = container.querySelector(".tool-block-header")!;
    fireEvent.click(header);
    expect(container.textContent).toContain("src/");
  });

  test("failed state renders expanded with error", () => {
    render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["x"] }}
        status="failed"
        error={{ code: "tool.execution_failed", message: "boom" }}
      />,
    );
    expect(screen.getByText(/boom/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/chat/ToolBlock.tsx`**

```tsx
import { useState } from "react";

export type ToolBlockStatus = "planned" | "running" | "completed" | "failed";

export interface ToolBlockProps {
  callId: string;
  tool: string;
  input: unknown;
  status: ToolBlockStatus;
  output?: unknown;
  error?: { code: string; message: string };
}

export function ToolBlock(props: ToolBlockProps) {
  const defaultExpanded = props.status === "running" || props.status === "failed";
  const [manuallyToggled, setManuallyToggled] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const open = manuallyToggled ? expanded : defaultExpanded;

  const inputSummary = summarize(props.input);
  const statusLabel = labelFor(props.status);
  const statusColor = colorFor(props.status);

  return (
    <div className={`tool-block tool-block-${props.status}`}>
      <button
        type="button"
        className="tool-block-header"
        onClick={() => {
          setManuallyToggled(true);
          setExpanded((e) => !e);
        }}
      >
        <span className="tool-block-icon">{open ? "▼" : "▶"}</span>
        <strong className="tool-block-tool">{props.tool}</strong>
        <code className="tool-block-input">{inputSummary}</code>
        <span className="tool-block-status" style={{ color: statusColor }}>
          {statusLabel}
        </span>
      </button>
      {open ? (
        <div className="tool-block-body">
          <div className="tool-block-input-full">
            <span className="label">Input</span>
            <pre>{JSON.stringify(props.input, null, 2)}</pre>
          </div>
          {props.output !== undefined ? (
            <div className="tool-block-output">
              <span className="label">Output</span>
              <pre>{JSON.stringify(props.output, null, 2)}</pre>
            </div>
          ) : null}
          {props.error ? (
            <div className="tool-block-error">
              <span className="label">Error ({props.error.code})</span>
              <pre>{props.error.message}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function summarize(input: unknown): string {
  if (input && typeof input === "object" && "argv" in input) {
    const argv = (input as { argv?: unknown }).argv;
    if (Array.isArray(argv)) return argv.map(String).join(" ");
  }
  return JSON.stringify(input).slice(0, 60);
}

function labelFor(status: ToolBlockStatus): string {
  switch (status) {
    case "planned":
      return "排队中";
    case "running":
      return "运行中";
    case "completed":
      return "✓ 完成";
    case "failed":
      return "✗ 失败";
  }
}

function colorFor(status: ToolBlockStatus): string {
  switch (status) {
    case "running":
      return "#80b0ff";
    case "completed":
      return "#6dd29a";
    case "failed":
      return "#ff8080";
    default:
      return "inherit";
  }
}
```

- [ ] **Step 4: Run, expect 4 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): ToolBlock component with smart expand/collapse"
```

### Task 20: `chat/ApprovalCard.tsx`

**Files:**
- Create: `apps/desktop-ui/src/chat/ApprovalCard.tsx`
- Create: `apps/desktop-ui/src/chat/ApprovalCard.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/chat/ApprovalCard.test.tsx`:
```tsx
import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";

describe("ApprovalCard", () => {
  test("renders tool name and reason", () => {
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="outside workspace"
        submitting={false}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("shell.exec")).toBeDefined();
    expect(screen.getByText(/outside workspace/)).toBeDefined();
  });

  test("clicking 允许 calls onDecide('allow')", () => {
    const onDecide = mock(() => {});
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={false}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByText("允许"));
    expect(onDecide).toHaveBeenCalledWith("c1", "allow");
  });

  test("clicking 拒绝 calls onDecide('deny')", () => {
    const onDecide = mock(() => {});
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={false}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByText("拒绝"));
    expect(onDecide).toHaveBeenCalledWith("c1", "deny");
  });

  test("disabled while submitting", () => {
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={true}
        onDecide={() => {}}
      />,
    );
    const allow = screen.getByText("处理中…") as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/chat/ApprovalCard.tsx`**

```tsx
import type { ApprovalDecision } from "../api/runs";

export interface ApprovalCardProps {
  callId: string;
  tool: string;
  reason: string;
  submitting: boolean;
  onDecide: (callId: string, decision: ApprovalDecision) => void;
}

export function ApprovalCard(props: ApprovalCardProps) {
  return (
    <div className="approval-card">
      <div className="approval-card-header">
        <span aria-hidden="true">⚠️</span>
        <strong>需要批准 · {props.tool}</strong>
      </div>
      <p className="approval-card-reason">{props.reason}</p>
      <div className="approval-card-actions">
        <button
          type="button"
          className="approval-card-deny"
          onClick={() => props.onDecide(props.callId, "deny")}
          disabled={props.submitting}
        >
          {props.submitting ? "处理中…" : "拒绝"}
        </button>
        <button
          type="button"
          className="approval-card-allow"
          onClick={() => props.onDecide(props.callId, "allow")}
          disabled={props.submitting}
        >
          {props.submitting ? "处理中…" : "允许"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run, expect 4 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): ApprovalCard component"
```

### Task 21: `chat/Composer.tsx`

**Files:**
- Create: `apps/desktop-ui/src/chat/Composer.tsx`
- Create: `apps/desktop-ui/src/chat/Composer.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/chat/Composer.test.tsx`:
```tsx
import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "./Composer";

const agents = [
  { id: "a1", name: "Agent One" },
  { id: "a2", name: "Agent Two" },
];

describe("Composer", () => {
  test("Enter sends; Shift+Enter does not", () => {
    const onSend = mock(() => {});
    const onCancel = mock(() => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={onSend}
        onCancel={onCancel}
      />,
    );
    const ta = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("hello");

    fireEvent.change(ta, { target: { value: "next" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  test("running shows ⏹ cancel button", () => {
    const onCancel = mock(() => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={true}
        onSend={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByLabelText("取消"));
    expect(onCancel).toHaveBeenCalled();
  });

  test("agent select calls onSelectAgent", () => {
    const onSelectAgent = mock(() => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={onSelectAgent}
        running={false}
        onSend={() => {}}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByDisplayValue("Agent One") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "a2" } });
    expect(onSelectAgent).toHaveBeenCalledWith("a2");
  });

  test("empty input does not send on Enter", () => {
    const onSend = mock(() => {});
    render(
      <Composer
        agents={agents}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        running={false}
        onSend={onSend}
        onCancel={() => {}}
      />,
    );
    const ta = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/chat/Composer.tsx`**

```tsx
import { useState } from "react";

export interface ComposerProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  running: boolean;
  onSend: (input: string) => void;
  onCancel: () => void;
}

export function Composer(props: ComposerProps) {
  const [value, setValue] = useState("");

  function send() {
    const trimmed = value.trim();
    if (!trimmed || props.running) return;
    props.onSend(trimmed);
    setValue("");
  }

  return (
    <div className="composer">
      <textarea
        value={value}
        placeholder="输入问题…（Enter 发送，Shift+Enter 换行）"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-controls">
        <select
          value={props.selectedAgentId}
          onChange={(e) => props.onSelectAgent(e.target.value)}
        >
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {props.running ? (
          <button
            type="button"
            className="composer-cancel"
            aria-label="取消"
            onClick={props.onCancel}
          >
            ⏹
          </button>
        ) : (
          <button
            type="button"
            className="composer-send"
            aria-label="发送"
            onClick={send}
            disabled={!value.trim()}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run, expect 4 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): Composer component (Enter to send, ⏹ on running)"
```

### Task 22: `chat/RunEventStream.tsx`

**Files:**
- Create: `apps/desktop-ui/src/chat/RunEventStream.tsx`
- Create: `apps/desktop-ui/src/chat/RunEventStream.test.tsx`

`RunEventStream` reduces the SSE event array into a sequence of rendered blocks: text aggregated into bubbles, tool calls into ToolBlocks, asks into ApprovalCards. The reduction logic is pure and testable.

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/chat/RunEventStream.test.tsx`:
```tsx
import { describe, expect, test } from "bun:test";
import { reduceRunEvents, type RunBlock } from "./RunEventStream";
import type { AnyRunEvent } from "../hooks/useRunStream";

const ev = (overrides: Partial<AnyRunEvent>): AnyRunEvent => ({
  type: "text.delta",
  runId: "r",
  seq: 0,
  createdAt: "2026-04-27T00:00:00.000Z",
  ...overrides,
});

describe("reduceRunEvents", () => {
  test("text.delta concatenated into one assistant text block until tool/final", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "run.started", seq: 0, agentId: "a", model: "gpt-5.4" }),
      ev({ type: "text.delta", seq: 1, text: "Hello, " }),
      ev({ type: "text.delta", seq: 2, text: "world." }),
      ev({ type: "run.completed", seq: 3, resultMessageId: "m-x", finalText: "Hello, world." }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("text");
    if (blocks[0].kind === "text") expect(blocks[0].content).toBe("Hello, world.");
  });

  test("tool.planned -> tool block with running status when not yet completed", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "tool.planned", seq: 0, callId: "c1", tool: "shell.exec", input: { argv: ["ls"] } }),
      ev({ type: "tool.started", seq: 1, callId: "c1" }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("tool");
    if (blocks[0].kind === "tool") expect(blocks[0].status).toBe("running");
  });

  test("tool.completed flips status to completed with output", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "tool.planned", seq: 0, callId: "c1", tool: "shell.exec", input: {} }),
      ev({ type: "tool.completed", seq: 1, callId: "c1", output: { stdout: "ok" } }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks[0].kind).toBe("tool");
    if (blocks[0].kind === "tool") {
      expect(blocks[0].status).toBe("completed");
      expect(blocks[0].output).toEqual({ stdout: "ok" });
    }
  });

  test("tool.ask becomes an approval block", () => {
    const events: AnyRunEvent[] = [
      ev({
        type: "tool.ask",
        seq: 0,
        callId: "c1",
        tool: "shell.exec",
        reason: "outside workspace",
        approvalToken: "tok",
      }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks[0].kind).toBe("approval");
  });

  test("text -> tool -> text -> final yields text+tool+text in order", () => {
    const events: AnyRunEvent[] = [
      ev({ type: "text.delta", seq: 0, text: "before " }),
      ev({ type: "tool.planned", seq: 1, callId: "c1", tool: "shell.exec", input: {} }),
      ev({ type: "tool.completed", seq: 2, callId: "c1", output: {} }),
      ev({ type: "text.delta", seq: 3, text: "after" }),
    ];
    const blocks = reduceRunEvents(events);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/chat/RunEventStream.tsx`**

```tsx
import type { AnyRunEvent } from "../hooks/useRunStream";
import type { ApprovalDecision } from "../api/runs";
import { MessageBubble } from "./MessageBubble";
import { ToolBlock, type ToolBlockStatus } from "./ToolBlock";
import { ApprovalCard } from "./ApprovalCard";

export type RunBlock =
  | { kind: "text"; content: string; firstSeq: number }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      input: unknown;
      status: ToolBlockStatus;
      output?: unknown;
      error?: { code: string; message: string };
      firstSeq: number;
    }
  | {
      kind: "approval";
      callId: string;
      tool: string;
      reason: string;
      approvalToken: string;
      firstSeq: number;
    };

export function reduceRunEvents(events: readonly AnyRunEvent[]): RunBlock[] {
  const blocks: RunBlock[] = [];
  const toolIndex = new Map<string, number>(); // callId -> blocks index
  const approvalIndex = new Map<string, number>(); // callId -> blocks index

  for (const e of events) {
    switch (e.type) {
      case "text.delta": {
        const last = blocks[blocks.length - 1];
        const piece = String(e.text ?? "");
        if (last && last.kind === "text") {
          last.content += piece;
        } else {
          blocks.push({ kind: "text", content: piece, firstSeq: e.seq });
        }
        break;
      }
      case "tool.planned": {
        const callId = String(e.callId);
        const idx = blocks.length;
        toolIndex.set(callId, idx);
        blocks.push({
          kind: "tool",
          callId,
          tool: String(e.tool ?? ""),
          input: e.input,
          status: "planned",
          firstSeq: e.seq,
        });
        break;
      }
      case "tool.started": {
        const callId = String(e.callId);
        const idx = toolIndex.get(callId);
        if (idx !== undefined && blocks[idx].kind === "tool") {
          (blocks[idx] as Extract<RunBlock, { kind: "tool" }>).status = "running";
        }
        break;
      }
      case "tool.completed": {
        const callId = String(e.callId);
        const idx = toolIndex.get(callId);
        if (idx !== undefined && blocks[idx].kind === "tool") {
          const block = blocks[idx] as Extract<RunBlock, { kind: "tool" }>;
          block.status = "completed";
          block.output = e.output;
        }
        // approval card (if any) is satisfied
        const aIdx = approvalIndex.get(callId);
        if (aIdx !== undefined) {
          // We keep the approval block for context but downstream renderers
          // can hide it once the tool completed. Leave in place.
        }
        break;
      }
      case "tool.failed": {
        const callId = String(e.callId);
        const idx = toolIndex.get(callId);
        if (idx !== undefined && blocks[idx].kind === "tool") {
          const block = blocks[idx] as Extract<RunBlock, { kind: "tool" }>;
          block.status = "failed";
          block.error = e.error as { code: string; message: string };
        } else {
          // tool.ask -> deny path: no prior tool.planned block existed because
          // the LLM emitted tool.plan only on first attempt; failed without a
          // planned-block is rare. Synthesize a minimal failed block.
          blocks.push({
            kind: "tool",
            callId,
            tool: "(unknown)",
            input: undefined,
            status: "failed",
            error: e.error as { code: string; message: string },
            firstSeq: e.seq,
          });
        }
        break;
      }
      case "tool.ask": {
        const callId = String(e.callId);
        const idx = blocks.length;
        approvalIndex.set(callId, idx);
        blocks.push({
          kind: "approval",
          callId,
          tool: String(e.tool ?? ""),
          reason: String(e.reason ?? ""),
          approvalToken: String(e.approvalToken ?? ""),
          firstSeq: e.seq,
        });
        break;
      }
      // run.started / run.completed / run.failed / run.cancelled produce no inline block
    }
  }

  return blocks;
}

export interface RunEventStreamProps {
  events: readonly AnyRunEvent[];
  submittingApprovals: ReadonlySet<string>;
  onDecide: (callId: string, decision: ApprovalDecision) => void;
}

export function RunEventStream(props: RunEventStreamProps) {
  const blocks = reduceRunEvents(props.events);
  return (
    <div className="run-event-stream">
      {blocks.map((b, i) => {
        if (b.kind === "text") {
          return <MessageBubble key={i} role="assistant" content={b.content} />;
        }
        if (b.kind === "tool") {
          return (
            <ToolBlock
              key={`${b.callId}-${b.firstSeq}`}
              callId={b.callId}
              tool={b.tool}
              input={b.input}
              status={b.status}
              output={b.output}
              error={b.error}
            />
          );
        }
        return (
          <ApprovalCard
            key={`${b.callId}-${b.firstSeq}`}
            callId={b.callId}
            tool={b.tool}
            reason={b.reason}
            submitting={props.submittingApprovals.has(b.callId)}
            onDecide={props.onDecide}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run, expect 5 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): RunEventStream with reduceRunEvents (text/tool/approval blocks)"
```

### Task 23: `chat/ChatView.tsx`

**Files:**
- Create: `apps/desktop-ui/src/chat/ChatView.tsx`
- Create: `apps/desktop-ui/src/chat/ChatView.test.tsx`

`ChatView` composes message history (from `useMessages`) + active run stream (from `useRunStream` + `useApproval`) + composer. It owns the per-conversation stream lifecycle.

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/chat/ChatView.test.tsx`:
```tsx
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ChatView } from "./ChatView";
import type { MessageDto } from "../api/conversations";

const msgs: MessageDto[] = [
  {
    id: "m-1",
    conversationId: "c-1",
    role: "user",
    content: "hello",
    runId: null,
    createdAt: "2026-04-27T00:00:00.000Z",
  },
  {
    id: "m-2",
    conversationId: "c-1",
    role: "assistant",
    content: "hi back",
    runId: "r-1",
    createdAt: "2026-04-27T00:00:00.000Z",
  },
];

describe("ChatView", () => {
  test("renders historical messages", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={msgs}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        submittingApprovals={new Set()}
        onSend={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("hello")).toBeDefined();
    expect(screen.getByText("hi back")).toBeDefined();
  });

  test("shows reconnecting chip when status=reconnecting", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="reconnecting"
        runError="net"
        submittingApprovals={new Set()}
        onSend={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/重连中/)).toBeDefined();
  });

  test("shows empty state when no messages and idle", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        submittingApprovals={new Set()}
        onSend={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/选择智能体/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/chat/ChatView.tsx`**

```tsx
import type { MessageDto } from "../api/conversations";
import type { ApprovalDecision } from "../api/runs";
import type { RunStreamStatus, AnyRunEvent } from "../hooks/useRunStream";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { RunEventStream } from "./RunEventStream";

export interface ChatViewProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;

  messages: ReadonlyArray<MessageDto>;
  runEvents: ReadonlyArray<AnyRunEvent>;
  runStatus: RunStreamStatus;
  runError: string | null;

  submittingApprovals: ReadonlySet<string>;
  onSend: (input: string) => void;
  onCancel: () => void;
  onDecide: (callId: string, decision: ApprovalDecision) => void;
}

export function ChatView(props: ChatViewProps) {
  const running =
    props.runStatus === "connecting" ||
    props.runStatus === "streaming" ||
    props.runStatus === "reconnecting";

  const hasContent = props.messages.length > 0 || props.runEvents.length > 0;

  return (
    <main className="chat-main">
      {props.runStatus === "reconnecting" ? (
        <div className="reconnect-chip">重连中…（{props.runError ?? ""}）</div>
      ) : null}

      <section className={`chat-stage ${hasContent ? "has-messages" : ""}`}>
        {hasContent ? (
          <div className="message-list">
            {props.messages.map((m) => (
              <MessageBubble key={m.id} role={m.role} content={m.content} />
            ))}
            <RunEventStream
              events={props.runEvents}
              submittingApprovals={props.submittingApprovals}
              onDecide={props.onDecide}
            />
          </div>
        ) : (
          <div className="empty-state">
            <div className="hero-mark">V</div>
            <h2>Vulture</h2>
            <p>选择智能体，然后直接输入任务。</p>
          </div>
        )}
      </section>

      <section className="composer-wrap">
        <Composer
          agents={props.agents}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={props.onSelectAgent}
          running={running}
          onSend={props.onSend}
          onCancel={props.onCancel}
        />
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Run, expect 3 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): ChatView shell composing messages + runEvents + composer"
```

### Task 24: `chat/ConversationList.tsx`

**Files:**
- Create: `apps/desktop-ui/src/chat/ConversationList.tsx`
- Create: `apps/desktop-ui/src/chat/ConversationList.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/desktop-ui/src/chat/ConversationList.test.tsx`:
```tsx
import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConversationList } from "./ConversationList";
import type { ConversationDto } from "../api/conversations";

const items: ConversationDto[] = [
  {
    id: "c-1",
    agentId: "a",
    title: "First",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  },
  {
    id: "c-2",
    agentId: "a",
    title: "Second",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  },
];

describe("ConversationList", () => {
  test("renders titles and marks active", () => {
    render(
      <ConversationList
        items={items}
        activeId="c-2"
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    const second = screen.getByText("Second").closest("button")!;
    expect(second.className).toContain("active");
  });

  test("clicking item calls onSelect with id", () => {
    const onSelect = mock(() => {});
    render(
      <ConversationList items={items} activeId={null} onSelect={onSelect} onNew={() => {}} />,
    );
    fireEvent.click(screen.getByText("First"));
    expect(onSelect).toHaveBeenCalledWith("c-1");
  });

  test("+ 新消息 calls onNew", () => {
    const onNew = mock(() => {});
    render(
      <ConversationList items={items} activeId={null} onSelect={() => {}} onNew={onNew} />,
    );
    fireEvent.click(screen.getByText(/新消息/));
    expect(onNew).toHaveBeenCalled();
  });

  test("empty state renders with hint", () => {
    render(
      <ConversationList items={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />,
    );
    expect(screen.getByText(/没有会话/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Write `apps/desktop-ui/src/chat/ConversationList.tsx`**

```tsx
import type { ConversationDto } from "../api/conversations";

export interface ConversationListProps {
  items: ReadonlyArray<ConversationDto>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function ConversationList(props: ConversationListProps) {
  return (
    <aside className="chat-sidebar">
      <div className="window-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="brand">
        <div className="brand-mark">V</div>
        <strong>Vulture Work</strong>
      </div>

      <button type="button" className="nav-item active" onClick={props.onNew}>
        <span>+</span>新消息
      </button>

      <section className="conversation-list">
        <p>会话</p>
        {props.items.length === 0 ? (
          <p className="empty">还没有会话，点击上方"+ 新消息"开始</p>
        ) : (
          props.items.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`conversation ${c.id === props.activeId ? "active" : ""}`}
              onClick={() => props.onSelect(c.id)}
            >
              <span className="mini-mark">V</span>
              {c.title || "(无标题)"}
            </button>
          ))
        )}
      </section>
    </aside>
  );
}
```

- [ ] **Step 4: Run, expect 4 PASS** + typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): ConversationList sidebar component"
```

---

## Group G — App.tsx integration (M6)

### Task 25: Rewire `App.tsx` and add end-to-end integration test

**Files:**
- Modify: `apps/desktop-ui/src/App.tsx` (rewrite)
- Create: `apps/desktop-ui/src/App.integration.test.tsx`

This is the integration milestone. App.tsx shrinks to ~150 lines: shell layout + glue between hooks and components.

- [ ] **Step 1: Write the failing integration test**

`apps/desktop-ui/src/App.integration.test.tsx`:
```tsx
import { describe, expect, test } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./App";
import { buildServer } from "../../gateway/src/server";
import type { GatewayConfig } from "../../gateway/src/env";

// Note: this test runs the gateway in-process via app.request(...) and uses a
// fetch mock that proxies to it. We do NOT spawn an HTTP server.

const TOKEN = "x".repeat(43);

function makeGatewayFetch() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-app-int-"));
  const cfg: GatewayConfig = {
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: process.pid,
    profileDir: dir,
  };
  const app = buildServer(cfg);
  const proxiedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    return app.request(path, init as RequestInit);
  };
  return { fetch: proxiedFetch, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe.skip("App integration (TODO: wire RuntimeDescriptor for tests)", () => {
  // This integration test is a placeholder that documents the desired flow.
  // It is intentionally `describe.skip` because RuntimeDescriptor is loaded
  // via Tauri-only `useRuntimeDescriptor`. Wiring it for happy-dom tests is
  // a Phase 4 follow-up. Manual smoke covers the path for now.
  test("send a message → assistant message appears", async () => {
    const { fetch: gatewayFetch, cleanup } = makeGatewayFetch();
    // ... see manual smoke notes ...
    cleanup();
  });
});
```

NOTE: a fully automated end-to-end test through React + happy-dom + buildServer is non-trivial because `useRuntimeDescriptor` reads from the Tauri runtime. The test file above documents the intended shape but skips. **Phase 3b ships M6 with a manual smoke checklist instead.** A follow-up task (post-3b) wires a test runtime descriptor injection.

- [ ] **Step 2: Rewrite `apps/desktop-ui/src/App.tsx`**

```tsx
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import type {
  CodexLoginRequest,
  CodexLoginStart,
  OpenAiAuthStatus,
} from "./commandCenterTypes";
import { useRuntimeDescriptor } from "./runtime/useRuntimeDescriptor";
import { createApiClient } from "./api/client";
import { agentsApi, type Agent } from "./api/agents";
import { profileApi } from "./api/profile";
import { runsApi } from "./api/runs";
import { ConversationList } from "./chat/ConversationList";
import { ChatView } from "./chat/ChatView";
import { useConversations } from "./hooks/useConversations";
import { useMessages } from "./hooks/useMessages";
import { useRunStream } from "./hooks/useRunStream";
import { useApproval } from "./hooks/useApproval";

interface ProfileView {
  id: string;
  name: string;
  activeAgentId: string;
}

function authLabel(status: OpenAiAuthStatus | null) {
  if (!status?.configured) return "未认证";
  if (status.source === "codex") return "Codex OAuth";
  if (status.source === "environment") return "OPENAI_API_KEY";
  return "Keychain API key";
}

export function App() {
  const runtime = useRuntimeDescriptor();
  const apiClient = useMemo(
    () => (runtime.data ? createApiClient(runtime.data) : null),
    [runtime.data],
  );

  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [authStatus, setAuthStatus] = useState<OpenAiAuthStatus | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const conversations = useConversations(apiClient);
  const messages = useMessages(apiClient, activeConversationId);
  const runStream = useRunStream({ client: apiClient, runId: activeRunId });
  const approvals = useApproval({
    client: apiClient,
    runId: activeRunId,
    events: runStream.events,
  });

  // Bootstrap auth + profile + agents (one-shot)
  useEffect(() => {
    if (!apiClient) return;
    let mounted = true;
    (async () => {
      try {
        const [profileResult, agentList, nextAuthStatus] = await Promise.all([
          profileApi.get(apiClient),
          agentsApi.list(apiClient),
          invoke<OpenAiAuthStatus>("get_openai_auth_status").catch(() => null),
        ]);
        if (!mounted) return;
        setProfile({
          id: profileResult.id,
          name: profileResult.name,
          activeAgentId: profileResult.activeAgentId ?? "",
        });
        setAgents(agentList);
        setSelectedAgentId(
          (cur) => cur || profileResult.activeAgentId || agentList[0]?.id || "",
        );
        if (nextAuthStatus) setAuthStatus(nextAuthStatus);
      } catch {
        // surfaced via runtime.error or hook errors
      }
    })();
    return () => {
      mounted = false;
    };
  }, [apiClient]);

  async function handleSend(input: string) {
    if (!apiClient || !selectedAgentId) return;
    let cid = activeConversationId;
    if (!cid) {
      const created = await conversations.create({
        agentId: selectedAgentId,
        title: input.slice(0, 40),
      });
      cid = created.id;
      setActiveConversationId(cid);
    }
    const result = await runsApi.create(apiClient, cid, { input });
    setActiveRunId(result.run.id);
    messages.append(result.message);
  }

  async function handleCancel() {
    if (!apiClient || !activeRunId) return;
    try {
      await runsApi.cancel(apiClient, activeRunId);
    } catch {
      // ignore — UI will see run.cancelled via SSE
    }
  }

  function handleNew() {
    setActiveConversationId(null);
    setActiveRunId(null);
  }

  return (
    <div className="app-shell">
      <ConversationList
        items={conversations.items}
        activeId={activeConversationId}
        onSelect={(id) => {
          setActiveConversationId(id);
          setActiveRunId(null);
        }}
        onNew={handleNew}
      />
      <main className="chat-main-wrap">
        {runtime.data && (
          <div className="runtime-debug" style={{ fontSize: 11, opacity: 0.6, padding: "2px 8px" }}>
            gateway:{runtime.data.gateway.port} shell:{runtime.data.shell.port} · auth:
            {authLabel(authStatus)} · profile:{profile?.name ?? "Default"}
          </div>
        )}
        <ChatView
          agents={agents.map((a) => ({ id: a.id, name: a.name }))}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          messages={messages.items}
          runEvents={runStream.events}
          runStatus={runStream.status}
          runError={runStream.error}
          submittingApprovals={approvals.submitting}
          onSend={handleSend}
          onCancel={handleCancel}
          onDecide={approvals.decide}
        />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck + UI build**

```bash
bun --filter @vulture/desktop-ui typecheck 2>&1 | tail -3
bun --filter @vulture/desktop-ui build 2>&1 | tail -5
bun test 2>&1 | tail -5
```

Expect typecheck exit 0; build green; all existing tests still pass.

- [ ] **Step 4: Manual smoke checklist**

Document in the commit message that the following manual smoke was performed (or scheduled if env not ready):
1. `cargo tauri dev` (in `apps/desktop-shell`)
2. UI loads; sidebar shows "还没有会话"
3. Click "+ 新消息"; type "list workspace files"; press Enter
4. Without `OPENAI_API_KEY`: assistant message says "OPENAI_API_KEY not configured…"
5. With `OPENAI_API_KEY`: assistant streams text, possibly emits `shell.exec ls` (auto-allowed in workspace), shows tool block, completes
6. Run a command outside workspace (`shell.exec rm /tmp/foo`) — inline ApprovalCard appears, "拒绝" yields `tool.failed (tool.permission_denied)` and the agent adapts
7. Disconnect Wi-Fi mid-stream → "重连中…" chip → reconnect → events resume
8. Refresh app → sidebar lists past conversations; clicking shows history

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "feat(ui): rewrite App.tsx as chat client of gateway HTTP+SSE"
```

---

## Group H — Cleanup (M7)

### Task 26: Drop dead CSS + unused TypeScript helpers

**Files:**
- Modify: `apps/desktop-ui/src/styles.css`
- Modify: `apps/desktop-ui/src/App.tsx` (delete leftover dead helpers, if any)
- Possibly delete: `apps/desktop-ui/src/browserTypes.ts`, `commandCenterTypes.ts` (verify usage)

- [ ] **Step 1: Find dead CSS classes**

```bash
# Extract CSS classes
grep -oE '\.[a-zA-Z][a-zA-Z0-9_-]+' apps/desktop-ui/src/styles.css | sort -u > /tmp/css-classes.txt
# For each class, see if it's referenced in any .tsx file
while read class; do
  name="${class:1}"
  if ! grep -qE "(className=\"[^\"]*\b$name\b|className=\\{[^}]*$name)" apps/desktop-ui/src/**/*.tsx 2>/dev/null; then
    echo "UNUSED: $class"
  fi
done < /tmp/css-classes.txt
```

Expected dead classes (Phase 3a placeholder leftovers): `.starter-grid`, `.code-box`, `.api-key-row`, `.run-meta`, `.muted-bubble`, `.auth-pill`, etc. Verify each before removing.

- [ ] **Step 2: Remove unused classes**

Edit `apps/desktop-ui/src/styles.css` and delete the verified-unused class blocks. Add the new chat block styles (`.tool-block`, `.tool-block-header`, `.approval-card`, `.reconnect-chip`, `.composer-cancel`, `.composer-send`).

The new styles can be functional rather than polished — the goal is "looks intentional, not broken". A polish pass is left to a future iteration.

- [ ] **Step 3: Find and delete unused exports in browserTypes.ts / commandCenterTypes.ts**

```bash
grep -rn "from \"./browserTypes\"\|from \"./commandCenterTypes\"" apps/desktop-ui/src/ | grep -v ".test."
```

Keep types that are still imported (likely `OpenAiAuthStatus`, `CodexLoginRequest`, `CodexLoginStart`). Delete any types referenced only from the removed App.tsx code.

- [ ] **Step 4: Run all checks**

```bash
bun test 2>&1 | tail -5
bun --filter '*' typecheck 2>&1 | tail -10
bun --filter @vulture/desktop-ui build 2>&1 | tail -5
cargo test --workspace 2>&1 | grep "^test result"
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
```

ALL must pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-ui
git commit -m "chore(ui): drop dead CSS + types after App.tsx rewrite"
```

---

## Self-Review

**Spec coverage:** Each spec section maps to a milestone:
- Spec §"Backend / Gateway" → Tasks 5, 8, 9, 10, 11, 12
- Spec §"Backend / Rust shell" → Tasks 6, 7
- Spec §"Protocol" → Task 1
- Spec §"UI / file structure" → Tasks 2-4 (api), 17 (test infra), 18-24 (chat), 13-16 (hooks), 25 (App.tsx)
- Spec §"State management" → hooks tasks (13-16) embed reducers; no global store
- Spec §"SSE consumer" → Task 4
- Spec §"Reconnect" → Task 15 (useRunStream backoff)
- Spec §"Approval data path" → Tasks 9 (approvals route), 16 (useApproval), 20 (ApprovalCard)
- Spec §"Composer behaviour" → Task 21 (Composer)
- Spec §"Migration milestones M1-M7" → Groups A-H

**Acceptance criteria coverage:**
- "User with key sends message → streaming text → tool call inside workspace auto-runs → assistant summarizes" — Tasks 11+12 (real LLM) + 6 (workspace allow) + 22 (RunEventStream) + 25 (App.tsx integration)
- "Outside-workspace command → ApprovalCard → 允许 resumes / 拒绝 fails" — Tasks 8 (ask loop) + 9 (approvals route) + 20 (ApprovalCard)
- "Wi-Fi drop → 重连中… → resumes" — Task 15 (useRunStream backoff) + 23 (ChatView reconnect chip)
- "Reopen app → sidebar lists past conversations" — Tasks 13 (useConversations) + 24 (ConversationList)
- "Without key: assistant explains" — Task 11 (makeStubLlmFallback)
- "Cancel run mid-stream releases pending approvals" — Tasks 5 (ApprovalQueue abort) + 10 (cancel propagation) + 21 (Composer ⏹)
- "grep returns nothing for start_*_run" — already true post-3a

**Type consistency:**
- `ToolBlockStatus` in Task 19 = `"planned" | "running" | "completed" | "failed"` — matches what `reduceRunEvents` in Task 22 sets.
- `ApprovalDecision` in api/runs.ts (Task 3) = same as protocol's `ApprovalDecisionSchema` enum (Task 1 reuses it).
- `RunStreamStatus` in useRunStream (Task 15) used unchanged in ChatView (Task 23).
- `AnyRunEvent` permissive shape in Task 15 used by Tasks 16 (useApproval), 22 (RunEventStream).
- `MessageDto` in api/conversations.ts (Task 2) used by useMessages (Task 14), MessageBubble adapter (Task 23 uses `m.role`/`m.content`).

**Placeholder scan:** No `TBD` / `TODO` / `implement later` in plan body. Two acknowledged forward references:
- Task 12 SDK call (`@openai/agents` exact API verified at impl time; design contract = `SdkRunEvent` enum is stable)
- Task 25 integration test is `describe.skip` documenting intent; manual smoke covers the path

These are explicit, scoped, and called out — not vague placeholders.

---

## Out of scope (3b → Phase 4)

- LLM-generated conversation titles
- Cross-process resume of in-flight runs after Tauri window close
- Automated end-to-end integration test through React + happy-dom + buildServer (Task 25 ships skipped + manual smoke)
- Approval timeout / TTL
- Approval policy memory ("don't ask again for this command")
- Browser tools real execution
- CSS polish pass (Task 26 only removes dead, doesn't refine)

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-27-l0-phase-3b-ui-llm.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance + code quality). Same flow Phase 3a used.

**2. Inline Execution** — batch with checkpoints in same session.

**Which approach?**

(Recommend Subagent-Driven again — 26 tasks across protocol/gateway/Rust/UI is non-trivial; per-task fresh context kept Phase 3a clean. Note that Task 12 — SDK integration — may need NEEDS_CONTEXT escalation if `@openai/agents` API surface differs from the design assumption; controller should be ready to provide Codex/SDK docs links on demand.)
