import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { runsRouter } from "./runs";
import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";
import { ApprovalQueue } from "../runtime/approvalQueue";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

const fakeLlm: LlmCallable = async function* (): AsyncGenerator<LlmYield, void, unknown> {
  yield { kind: "text.delta", text: "ok" };
  yield { kind: "final", text: "ok" };
};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-runs-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const c = convs.create({ agentId: "local-work-agent" });
  const app = runsRouter({
    conversations: convs,
    messages: msgs,
    runs,
    llm: fakeLlm,
    tools: async () => "noop",
    approvalQueue: new ApprovalQueue(),
    cancelSignals: new Map<string, AbortController>(),
    systemPromptForAgent: () => "system",
    modelForAgent: () => "gpt-5.4",
    workspacePathForAgent: () => "",
  });
  return { app, c, runs, msgs, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("/v1/runs", () => {
  test("POST /v1/conversations/:cid/runs returns 202 + run + message + eventStreamUrl", async () => {
    const { app, c, cleanup } = fresh();
    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k1" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.run.id).toMatch(/^r-/);
    expect(body.message.role).toBe("user");
    expect(body.eventStreamUrl).toMatch(/\/v1\/runs\/.+\/events/);
    cleanup();
  });

  test("POST without Idempotency-Key → 400", async () => {
    const { app, c, cleanup } = fresh();
    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });

  test("tool call path: tool.plan → await.tool → tool.completed events persisted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-runs-tool-"));
    const { openDatabase } = await import("../persistence/sqlite");
    const { applyMigrations } = await import("../persistence/migrate");
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    const convs = new ConversationStore(db);
    const msgs = new MessageStore(db);
    const runs = new RunStore(db);
    const c = convs.create({ agentId: "local-work-agent" });

    const toolLlm: LlmCallable = async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "tool.plan", callId: "c1", tool: "shell.exec", input: { argv: ["echo"] } };
      yield { kind: "await.tool", callId: "c1" };
      yield { kind: "final", text: "done" };
    };

    let toolCalled = 0;
    const app = runsRouter({
      conversations: convs,
      messages: msgs,
      runs,
      llm: toolLlm,
      tools: async () => {
        toolCalled += 1;
        return { stdout: "hi" };
      },
      approvalQueue: new ApprovalQueue(),
      cancelSignals: new Map<string, AbortController>(),
      systemPromptForAgent: () => "system",
      modelForAgent: () => "gpt-5.4",
      workspacePathForAgent: () => "",
    });

    const rRes = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "tk" },
      body: JSON.stringify({ input: "test" }),
    });
    expect(rRes.status).toBe(202);
    const { run } = (await rRes.json()) as { run: { id: string } };

    // Poll until terminal
    let final: { status: string } = { status: "running" };
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const get = await app.request(`/v1/runs/${run.id}`, { headers: auth });
      final = (await get.json()) as { status: string };
      if (["succeeded", "failed", "cancelled"].includes(final.status)) break;
    }
    expect(final.status).toBe("succeeded");
    expect(toolCalled).toBe(1);

    // Verify event sequence in run_events table
    const events = runs.listEventsAfter(run.id, -1);
    const types = events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("tool.planned");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.completed");
    expect(types).toContain("run.completed");
    // Order check: tool.planned before tool.started before tool.completed
    const planned = types.indexOf("tool.planned");
    const started = types.indexOf("tool.started");
    const completed = types.indexOf("tool.completed");
    expect(planned).toBeLessThan(started);
    expect(started).toBeLessThan(completed);

    db.close();
    rmSync(dir, { recursive: true });
  });

  test("POST cancel on completed run → 409 run.already_completed", async () => {
    const { app, c, runs, msgs, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markSucceeded(run.id, "result");
    const res = await app.request(`/v1/runs/${run.id}/cancel`, { method: "POST", headers: auth });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("run.already_completed");
    cleanup();
  });

  // This test verifies the runner ↔ tools-callable contract end-to-end. It uses
  // a fakeShellTools that simulates the ask flow internally; the production
  // makeShellCallbackTools' while-loop is unit-tested in
  // apps/gateway/src/runtime/shellCallbackTools.test.ts.
  test("tool callback ask path: emits tool.ask, awaits approval, retries with token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-runs-ask-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    const convs = new ConversationStore(db);
    const msgs = new MessageStore(db);
    const runs = new RunStore(db);
    const c = convs.create({ agentId: "local-work-agent" });

    const approvalQueue = new ApprovalQueue();
    const cancelSignals = new Map<string, AbortController>();

    // Simulate the shell HTTP server: first call emits tool.ask + awaits queue;
    // second call (with the same callId) returns the tool result.
    let invokeCount = 0;
    const tokenSeen: string[] = [];
    const fakeShellTools = async (call: {
      callId: string;
      tool: string;
      input: unknown;
      runId: string;
      workspacePath: string;
    }): Promise<unknown> => {
      invokeCount += 1;
      if (invokeCount === 1) {
        runs.appendEvent(call.runId, {
          type: "tool.ask",
          callId: call.callId,
          tool: call.tool,
          reason: "test-ask",
          approvalToken: "test-tok",
        });
        const ac = cancelSignals.get(call.runId) ?? new AbortController();
        const decision = await approvalQueue.wait(call.callId, ac.signal);
        if (decision === "deny") {
          const e = new Error("denied") as Error & { code: string };
          e.code = "tool.permission_denied";
          throw e;
        }
        tokenSeen.push("test-tok");
      }
      return { stdout: "ok" };
    };

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
      cancelSignals,
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
    expect(invokeCount).toBe(1);
    expect(tokenSeen).toEqual(["test-tok"]);

    db.close();
    rmSync(dir, { recursive: true });
  });

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
});
