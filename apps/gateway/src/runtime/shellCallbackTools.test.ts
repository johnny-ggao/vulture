import { describe, expect, test } from "bun:test";
import { makeShellApprovalHandler, makeShellCallbackTools } from "./shellCallbackTools";
import { ApprovalQueue } from "./approvalQueue";
import { ToolCallError } from "@vulture/agent-runtime";
import { createRuntimeHookRunner } from "./runtimeHooks";
import type { PartialRunEvent } from "../domain/runStore";

interface CallRecord {
  url: string;
  body: {
    callId: string;
    runId: string;
    tool: string;
    input: unknown;
    workspacePath: string;
    approvalToken?: string;
  };
}

function fakeFetchSequence(responses: Array<{ status: number; body: unknown }>): {
  fetchFn: typeof fetch;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let idx = 0;
  const fetchFn = (async (url: string | URL | Request, init: RequestInit | undefined) => {
    const path = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: path, body });
    const r = responses[idx++] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("makeShellCallbackTools", () => {
  test("ask → approve → completed: makes 2 fetch calls; second carries approvalToken", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-1", new AbortController());
    const events: Array<{ runId: string; partial: PartialRunEvent }> = [];

    const { fetchFn, calls } = fakeFetchSequence([
      {
        status: 200,
        body: {
          status: "ask",
          callId: "c1",
          approvalToken: "tok-abc",
          reason: "outside workspace",
        },
      },
      {
        status: 200,
        body: { status: "completed", callId: "c1", output: { stdout: "hi" } },
      },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: (runId, partial) => events.push({ runId, partial }),
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
    });

    const promise = tools({
      callId: "c1",
      runId: "r-1",
      tool: "shell.exec",
      input: { argv: ["x"] },
      workspacePath: "",
    });

    // Wait briefly for the first fetch + ask emission, then approve.
    // Ordering: tool.planned → tool.ask → (approval) → tool.started → tool.completed
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.partial.type)).toEqual(["tool.planned", "tool.ask"]);
    expect(queue.resolve("c1", "allow")).toBe(true);

    const result = await promise;
    expect(result).toEqual({ stdout: "hi" });
    expect(calls.length).toBe(2);
    expect(calls[0].body.approvalToken).toBeUndefined();
    expect(calls[1].body.approvalToken).toBe("tok-abc");
    // Final event order: planned, ask, started, completed
    expect(events.map((e) => e.partial.type)).toEqual([
      "tool.planned",
      "tool.ask",
      "tool.started",
      "tool.completed",
    ]);
  });

  test("full access mode auto-approves callback ask without emitting tool.ask", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-1", new AbortController());
    const events: Array<{ runId: string; partial: PartialRunEvent }> = [];
    const { fetchFn, calls } = fakeFetchSequence([
      {
        status: 200,
        body: {
          status: "ask",
          callId: "c1",
          approvalToken: "tok-abc",
          reason: "outside workspace",
        },
      },
      {
        status: 200,
        body: { status: "completed", callId: "c1", output: { stdout: "hi" } },
      },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: (runId, partial) => events.push({ runId, partial }),
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
      permissionModeForRun: () => "full_access",
    });

    const result = await tools({
      callId: "c1",
      runId: "r-1",
      tool: "shell.exec",
      input: { argv: ["x"] },
      workspacePath: "",
    });

    expect(result).toEqual({ stdout: "hi" });
    expect(calls.length).toBe(2);
    expect(calls[1].body.approvalToken).toBe("tok-abc");
    expect(events.map((e) => e.partial.type)).toEqual([
      "tool.planned",
      "tool.started",
      "tool.completed",
    ]);
  });

  test("ask response accepts Rust snake_case approval_token", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-1", new AbortController());
    const events: Array<{ runId: string; partial: PartialRunEvent }> = [];

    const { fetchFn, calls } = fakeFetchSequence([
      {
        status: 200,
        body: {
          status: "ask",
          call_id: "c1",
          approval_token: "tok-rust",
          reason: "outside workspace",
        },
      },
      {
        status: 200,
        body: { status: "completed", call_id: "c1", output: { stdout: "hi" } },
      },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: (runId, partial) => events.push({ runId, partial }),
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
    });

    const promise = tools({
      callId: "c1",
      runId: "r-1",
      tool: "shell.exec",
      input: { argv: ["x"] },
      workspacePath: "",
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(events[1].partial).toMatchObject({
      type: "tool.ask",
      approvalToken: "tok-rust",
    });
    expect(queue.resolve("c1", "allow")).toBe(true);

    await promise;
    expect(calls[1].body.approvalToken).toBe("tok-rust");
  });

  test("ask → deny throws ToolCallError(tool.permission_denied)", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-1", new AbortController());

    const { fetchFn } = fakeFetchSequence([
      {
        status: 200,
        body: { status: "ask", callId: "c1", approvalToken: "tok", reason: "x" },
      },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: () => undefined,
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
    });

    const promise = tools({
      callId: "c1",
      runId: "r-1",
      tool: "shell.exec",
      input: {},
      workspacePath: "",
    });
    await new Promise((r) => setTimeout(r, 20));
    queue.resolve("c1", "deny");
    await expect(promise).rejects.toMatchObject({
      code: "tool.permission_denied",
    });
  });

  test("ask → timeout emits tool.failed and throws ToolCallError(tool.approval_timeout)", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-1", new AbortController());
    const events: Array<{ runId: string; partial: PartialRunEvent }> = [];

    const { fetchFn } = fakeFetchSequence([
      {
        status: 200,
        body: { status: "ask", callId: "c1", approvalToken: "tok", reason: "x" },
      },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: (runId, partial) => events.push({ runId, partial }),
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
      approvalTimeoutMs: 5,
    });

    await expect(
      tools({
        callId: "c1",
        runId: "r-1",
        tool: "shell.exec",
        input: {},
        workspacePath: "",
      }),
    ).rejects.toMatchObject({
      code: "tool.approval_timeout",
    });

    expect(events.map((e) => e.partial.type)).toEqual([
      "tool.planned",
      "tool.ask",
      "tool.failed",
    ]);
    expect(events[2].partial).toMatchObject({
      type: "tool.failed",
      error: { code: "tool.approval_timeout" },
    });
  });

  test("strict SDK mode rejects Rust ask responses instead of blocking on local approvals", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-1", new AbortController());
    const events: Array<{ runId: string; partial: PartialRunEvent }> = [];

    const { fetchFn } = fakeFetchSequence([
      {
        status: 200,
        body: { status: "ask", callId: "c1", approvalToken: "tok", reason: "x" },
      },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: (runId, partial) => events.push({ runId, partial }),
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
      interactiveApprovalFallback: false,
    });

    await expect(
      tools({
        callId: "c1",
        runId: "r-1",
        tool: "shell.exec",
        input: {},
        workspacePath: "",
      }),
    ).rejects.toMatchObject({
      code: "tool.execution_failed",
      message: expect.stringContaining("OpenAI Agents SDK"),
    });

    expect(events.map((e) => e.partial.type)).toEqual(["tool.planned", "tool.failed"]);
    expect(events[1].partial).toMatchObject({
      type: "tool.failed",
      error: { code: "tool.execution_failed" },
    });
  });

  test("status=denied throws ToolCallError with the inner code", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    const { fetchFn } = fakeFetchSequence([
      {
        status: 200,
        body: {
          status: "denied",
          callId: "c1",
          error: { code: "tool.permission_denied", message: "policy says no" },
        },
      },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: () => undefined,
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
    });

    await expect(
      tools({
        callId: "c1",
        runId: "r-1",
        tool: "shell.exec",
        input: {},
        workspacePath: "",
      }),
    ).rejects.toMatchObject({
      code: "tool.permission_denied",
      message: "policy says no",
    });
  });

  test("status=failed throws ToolCallError with the inner code", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    const { fetchFn } = fakeFetchSequence([
      {
        status: 200,
        body: {
          status: "failed",
          callId: "c1",
          error: { code: "tool.execution_failed", message: "boom" },
        },
      },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: () => undefined,
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
    });

    await expect(
      tools({
        callId: "c1",
        runId: "r-1",
        tool: "shell.exec",
        input: {},
        workspacePath: "",
      }),
    ).rejects.toMatchObject({
      code: "tool.execution_failed",
      message: "boom",
    });
  });

  test("emits approval.required / approval.resolved hooks around the wait", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-1", new AbortController());
    const calls: Array<{ phase: string; payload: unknown }> = [];
    const runtimeHooks = createRuntimeHookRunner([
      {
        name: "approval.required",
        handler: (event) => {
          calls.push({ phase: "required", payload: event });
        },
      },
      {
        name: "approval.resolved",
        handler: (event) => {
          calls.push({ phase: "resolved", payload: event });
        },
      },
    ]);
    const { fetchFn } = fakeFetchSequence([
      {
        status: 200,
        body: {
          status: "ask",
          callId: "c1",
          approvalToken: "tok-1",
          reason: "outside workspace",
        },
      },
      { status: 200, body: { status: "completed", callId: "c1", output: { ok: true } } },
    ]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: () => undefined,
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
      runtimeHooks,
    });

    const promise = tools({
      callId: "c1",
      runId: "r-1",
      tool: "shell.exec",
      input: { argv: ["pwd"] },
      workspacePath: "/tmp/work",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.map((c) => c.phase)).toEqual(["required"]);
    expect(queue.resolve("c1", "allow")).toBe(true);
    await promise;

    expect(calls.map((c) => c.phase)).toEqual(["required", "resolved"]);
    expect(calls[0].payload).toMatchObject({
      runId: "r-1",
      callId: "c1",
      toolId: "shell.exec",
      reason: "outside workspace",
    });
    expect(calls[1].payload).toMatchObject({
      decision: "allow",
      callId: "c1",
    });
  });

  test("makeShellApprovalHandler emits approval hooks for the SDK approval path", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-sdk", new AbortController());
    const phases: string[] = [];
    const runtimeHooks = createRuntimeHookRunner([
      {
        name: "approval.required",
        handler: () => {
          phases.push("required");
        },
      },
      {
        name: "approval.resolved",
        handler: () => {
          phases.push("resolved");
        },
      },
    ]);

    const handler = makeShellApprovalHandler({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: () => undefined,
      approvalQueue: queue,
      cancelSignals,
      runtimeHooks,
    });

    const decisionPromise = handler({
      callId: "c-sdk",
      tool: "shell.exec",
      input: { argv: ["pwd"] },
      runId: "r-sdk",
      workspacePath: "/tmp/work",
      reason: "needs approval",
      approvalToken: "tok-sdk",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(queue.resolve("c-sdk", "deny")).toBe(true);
    expect(await decisionPromise).toBe("deny");
    expect(phases).toEqual(["required", "resolved"]);
  });

  test("makeShellApprovalHandler auto-allows SDK approval in full access mode", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    cancelSignals.set("r-sdk", new AbortController());
    const events: Array<{ runId: string; partial: PartialRunEvent }> = [];

    const handler = makeShellApprovalHandler({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: (runId, partial) => events.push({ runId, partial }),
      approvalQueue: queue,
      cancelSignals,
      permissionModeForRun: () => "full_access",
    });

    const decision = await handler({
      callId: "c-sdk",
      tool: "shell.exec",
      input: { argv: ["pwd"] },
      runId: "r-sdk",
      workspacePath: "/tmp/work",
      reason: "needs approval",
      approvalToken: "tok-sdk",
    });

    expect(decision).toBe("allow");
    expect(events).toEqual([]);
  });

  test("non-2xx HTTP throws ToolCallError(tool.execution_failed)", async () => {
    const queue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();
    const { fetchFn } = fakeFetchSequence([{ status: 500, body: { error: "internal" } }]);

    const tools = makeShellCallbackTools({
      callbackUrl: "http://shell",
      token: "tok",
      appendEvent: () => undefined,
      approvalQueue: queue,
      cancelSignals,
      fetch: fetchFn,
    });

    await expect(
      tools({
        callId: "c1",
        runId: "r-1",
        tool: "shell.exec",
        input: {},
        workspacePath: "",
      }),
    ).rejects.toMatchObject({
      code: "tool.execution_failed",
    });
  });
});
