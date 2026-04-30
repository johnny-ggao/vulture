import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { AttachmentStore } from "../domain/attachmentStore";
import {
  ConversationContextStore,
  type AddSessionItemInput,
} from "../domain/conversationContextStore";
import {
  runsRouter,
  startConversationRun,
  writeRunEventStream,
  type ResumeRunResult,
  type RunsDeps,
} from "./runs";
import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";
import { ApprovalQueue } from "../runtime/approvalQueue";
import type { AgentInputItem } from "@openai/agents";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

const fakeLlm: LlmCallable = async function* (): AsyncGenerator<LlmYield, void, unknown> {
  yield { kind: "text.delta", text: "ok" };
  yield { kind: "final", text: "ok" };
};

function fresh(
  resumeRun: (runId: string, mode: "auto" | "manual") => ResumeRunResult = mock((_runId: string, _mode: "auto" | "manual") => ({
    status: "scheduled" as const,
  })),
  llm: LlmCallable = fakeLlm,
  skillsPromptForAgent?: () => string,
  memoryPromptForRun?: (input: { agentId: string; input: string }) => Promise<string> | string,
  afterRunSucceeded?: RunsDeps["afterRunSucceeded"],
  noToolsLlm?: LlmCallable,
  contextFactory?: (db: ReturnType<typeof openDatabase>) => ConversationContextStore,
) {
  const dir = mkdtempSync(join(tmpdir(), "vulture-runs-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const attachments = new AttachmentStore(db, dir);
  const contexts = contextFactory?.(db) ?? new ConversationContextStore(db);
  const c = convs.create({ agentId: "local-work-agent" });
  const app = runsRouter({
    conversations: convs,
    messages: msgs,
    attachments,
    runs,
    llm,
    tools: async () => "noop",
    approvalQueue: new ApprovalQueue(),
    cancelSignals: new Map<string, AbortController>(),
    resumeRun,
    contexts,
    noToolsLlm,
    systemPromptForAgent: () => "system",
    skillsPromptForAgent,
    memoryPromptForRun,
    afterRunSucceeded,
    modelForAgent: () => "gpt-5.4",
    workspacePathForAgent: () => "",
  });
  return {
    app,
    convs,
    c,
    runs,
    msgs,
    attachments,
    contexts,
    resumeRun,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true }); },
  };
}

async function waitFor<T>(
  read: () => T,
  done: (value: T) => boolean,
  attempts = 50,
): Promise<T> {
  let value = read();
  for (let i = 0; i < attempts; i += 1) {
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = read();
  }
  return value;
}

describe("/v1/runs", () => {
  test("writeRunEventStream writes ping when reconnect has no missed events", async () => {
    const { c, runs, msgs, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.appendEvent(run.id, { type: "run.started", agentId: c.agentId, model: "gpt-5.4" });

    const writes: Array<{ event?: string; data: string }> = [];
    const stream = {
      aborted: false,
      closed: false,
      async writeSSE(message: { event?: string; data: string }) {
        writes.push(message);
        if (message.event === "ping") this.closed = true;
      },
    };

    await writeRunEventStream({ runs }, run.id, 0, stream, { heartbeatMs: 10 });

    expect(writes).toContainEqual({ event: "ping", data: "{}" });
    cleanup();
  });

  test("writeRunEventStream replays terminal event when reconnect is caught up", async () => {
    const { c, runs, msgs, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.appendEvent(run.id, { type: "run.started", agentId: c.agentId, model: "gpt-5.4" });
    runs.markFailed(run.id, { code: "internal", message: "boom" });
    const failed = runs.appendEvent(run.id, {
      type: "run.failed",
      error: { code: "internal", message: "boom" },
    });

    const writes: Array<{ event?: string; data: string }> = [];
    const stream = {
      aborted: false,
      closed: false,
      async writeSSE(message: { event?: string; data: string }) {
        writes.push(message);
      },
    };

    await writeRunEventStream({ runs }, run.id, failed.seq, stream, { heartbeatMs: 10 });

    expect(writes).toHaveLength(1);
    expect(writes[0].event).toBe("run.failed");
    expect(JSON.parse(writes[0].data).seq).toBe(failed.seq);
    cleanup();
  });

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

    let final: { status: string } = { status: "running" };
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const get = await app.request(`/v1/runs/${body.run.id}`, { headers: auth });
      final = (await get.json()) as { status: string };
      if (["succeeded", "failed", "cancelled"].includes(final.status)) break;
    }
    expect(final.status).toBe("succeeded");
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs stores user session item and passes session inputs", async () => {
    const seen: Parameters<LlmCallable>[0][] = [];
    const llm: LlmCallable = async function* (input): AsyncGenerator<LlmYield, void, unknown> {
      seen.push(input);
      yield { kind: "final", text: "ok" };
    };
    const { app, c, runs, contexts, cleanup } = fresh(undefined, llm);

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-user" },
      body: JSON.stringify({ input: "remember this turn" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    await waitFor(() => seen.length, (length) => length > 0);
    const userItems = contexts
      .listSessionItems(c.id)
      .filter((item) => item.role === "user");
    expect(userItems).toHaveLength(1);
    expect(userItems[0].messageId).toBe(body.message.id);
    expect(userItems[0].item).toMatchObject({
      type: "message",
      role: "user",
      providerData: { messageId: body.message.id },
    });
    expect(seen[0].session).toBeTruthy();
    expect(typeof seen[0].sessionInputCallback).toBe("function");
    await waitFor(() => runs.get(body.run.id), (run) => run?.status === "succeeded");
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs includes attachment metadata in user session text", async () => {
    const { app, c, runs, attachments, contexts, cleanup } = fresh();
    const draft = await attachments.createDraft({
      bytes: new TextEncoder().encode("attachment notes"),
      originalName: "notes.txt",
      mimeType: "text/plain",
    });

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-attachment" },
      body: JSON.stringify({ input: "read this", attachmentIds: [draft.id] }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    const userItem = contexts
      .listSessionItems(c.id)
      .find((item) => item.messageId === body.message.id);
    expect(JSON.stringify(userItem?.item)).toContain("read this");
    expect(JSON.stringify(userItem?.item)).toContain(draft.id);
    expect(JSON.stringify(userItem?.item)).toContain("notes.txt");
    expect(JSON.stringify(userItem?.item)).toContain("text/plain");
    await waitFor(() => runs.get(body.run.id), (run) => run?.status === "succeeded");
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs stores assistant session item after success", async () => {
    const { app, c, runs, contexts, cleanup } = fresh();

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-assistant" },
      body: JSON.stringify({ input: "answer me" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    const finalRun = await waitFor(
      () => runs.get(body.run.id),
      (run) => run?.status === "succeeded",
    );
    const assistantItem = contexts
      .listSessionItems(c.id)
      .find((item) => item.role === "assistant" && item.messageId === finalRun?.resultMessageId);
    expect(assistantItem?.item).toMatchObject({
      type: "message",
      role: "assistant",
      providerData: { messageId: finalRun?.resultMessageId },
    });
    expect(JSON.stringify(assistantItem?.item)).toContain("ok");
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs stores repeated assistant replies with distinct message ids", async () => {
    const { app, c, runs, contexts, cleanup } = fresh();

    const first = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "repeat-assistant-1" },
      body: JSON.stringify({ input: "first" }),
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    await waitFor(() => runs.get(firstBody.run.id), (run) => run?.status === "succeeded");

    const second = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "repeat-assistant-2" },
      body: JSON.stringify({ input: "second" }),
    });
    expect(second.status).toBe(202);
    const secondBody = await second.json();
    await waitFor(() => runs.get(secondBody.run.id), (run) => run?.status === "succeeded");

    const assistantItems = contexts
      .listSessionItems(c.id)
      .filter((item) => item.role === "assistant" && JSON.stringify(item.item).includes("ok"));
    expect(assistantItems).toHaveLength(2);
    expect(new Set(assistantItems.map((item) => item.messageId)).size).toBe(2);
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs returns 500 and creates no run/message when user session persistence fails", async () => {
    const { app, c, runs, msgs, cleanup } = fresh(
      undefined,
      fakeLlm,
      undefined,
      undefined,
      undefined,
      undefined,
      (db) => new class extends ConversationContextStore {
        override addSessionItems(conversationId: string, items: AddSessionItemInput[]): void {
          if (items.some((item) => item.role === "user")) {
            throw new Error("session write failed");
          }
          super.addSessionItems(conversationId, items);
        }
      }(db),
    );

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-user-fail" },
      body: JSON.stringify({ input: "cannot persist me" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("internal");
    expect(body.message).toContain("failed to persist conversation context session item");
    expect(body.message).toContain("session write failed");
    expect(runs.listForConversation(c.id)).toEqual([]);
    expect(msgs.listSince({ conversationId: c.id })).toEqual([]);
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs rolls back the user message when attachment linking fails", async () => {
    const { app, c, msgs, cleanup } = fresh();

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-attachment-fail" },
      body: JSON.stringify({ input: "bad attachment", attachmentIds: ["att-missing"] }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "attachment.not_found" });
    expect(msgs.listSince({ conversationId: c.id })).toEqual([]);
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs rolls back message and context when run creation fails", async () => {
    const { app, c, runs, msgs, contexts, cleanup } = fresh();
    const createMock = mock((input: Parameters<typeof runs.create>[0]) => {
      void input;
      throw new Error("run store failed");
    });
    runs.create = createMock as typeof runs.create;

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-run-create-fail" },
      body: JSON.stringify({ input: "cannot create run" }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "internal", message: "run store failed" });
    expect(msgs.listSince({ conversationId: c.id })).toEqual([]);
    expect(contexts.listSessionItems(c.id)).toEqual([]);
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs schedules compaction and preserves success hook", async () => {
    const afterRunSucceeded = mock(async () => {});
    const compactionCalls: Parameters<LlmCallable>[0][] = [];
    const noToolsLlm: LlmCallable = async function* (input): AsyncGenerator<LlmYield, void, unknown> {
      compactionCalls.push(input);
      yield { kind: "final", text: "Earlier turns summarized." };
    };
    const { app, c, contexts, cleanup } = fresh(
      undefined,
      fakeLlm,
      undefined,
      undefined,
      afterRunSucceeded,
      noToolsLlm,
    );
    contexts.addSessionItems(c.id, Array.from({ length: 11 }, (_, index) => {
      const role = index % 2 === 0 ? "user" : "assistant";
      const item = {
        type: "message",
        role,
        ...(role === "assistant" ? { status: "completed" as const } : {}),
        providerData: { messageId: `m-seed-${index}` },
        content: [
          {
            type: role === "user" ? "input_text" : "output_text",
            text: `seed ${index}`,
          },
        ],
      } as AgentInputItem;
      return {
        messageId: `m-seed-${index}`,
        role,
        item,
      };
    }));

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-compact" },
      body: JSON.stringify({ input: "new turn" }),
    });

    expect(res.status).toBe(202);
    await waitFor(() => afterRunSucceeded.mock.calls.length, (length) => length > 0);
    await waitFor(() => contexts.getContext(c.id), (context) => context !== null);
    expect(compactionCalls).toHaveLength(1);
    expect(contexts.getContext(c.id)).toMatchObject({
      conversationId: c.id,
      summary: "Earlier turns summarized.",
    });
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs does not move the compaction cutoff backwards", async () => {
    const noToolsLlm: LlmCallable = async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "final", text: "Older summary." };
    };
    const { app, c, contexts, cleanup } = fresh(
      undefined,
      fakeLlm,
      undefined,
      undefined,
      undefined,
      noToolsLlm,
    );
    contexts.addSessionItems(c.id, Array.from({ length: 13 }, (_, index) => {
      const role = index % 2 === 0 ? "user" : "assistant";
      return {
        messageId: `m-seed-${index}`,
        role,
        item: {
          type: "message",
          role,
          providerData: { messageId: `m-seed-${index}` },
          content: [
            {
              type: role === "user" ? "input_text" : "output_text",
              text: `seed ${index}`,
            },
          ],
        } as AgentInputItem,
      };
    }));
    contexts.upsertContext({
      conversationId: c.id,
      agentId: c.agentId,
      summary: "Newer summary.",
      summarizedThroughMessageId: "m-seed-10",
    });

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-compact-regressive" },
      body: JSON.stringify({ input: "new turn" }),
    });

    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(contexts.getContext(c.id)).toMatchObject({
      summary: "Newer summary.",
      summarizedThroughMessageId: "m-seed-10",
    });
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs does not duplicate the current user session item when SDK stores it", async () => {
    const llm: LlmCallable = async function* (input): AsyncGenerator<LlmYield, void, unknown> {
      await input.session?.addItems([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "dedupe me" }],
        } as AgentInputItem,
      ]);
      yield { kind: "final", text: "ok" };
    };
    const { app, c, contexts, cleanup } = fresh(undefined, llm);

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-dedupe" },
      body: JSON.stringify({ input: "dedupe me" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    await waitFor(
      () => contexts.listSessionItems(c.id).filter((item) => item.role === "assistant").length,
      (length) => length > 0,
    );
    const matchingUserItems = contexts
      .listSessionItems(c.id)
      .filter((item) => item.role === "user" && JSON.stringify(item.item).includes("dedupe me"));
    expect(matchingUserItems).toHaveLength(1);
    expect(matchingUserItems[0].messageId).toBe(body.message.id);
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs does not duplicate attachment-backed current user items from the SDK", async () => {
    const llm: LlmCallable = async function* (input): AsyncGenerator<LlmYield, void, unknown> {
      await input.session?.addItems([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "read attachment" },
            {
              type: "input_text",
              text: "Attached file: note.txt\nMIME type: text/plain\nContent:\nattachment notes",
            },
          ],
        } as AgentInputItem,
      ]);
      yield { kind: "final", text: "ok" };
    };
    const { app, c, attachments, contexts, cleanup } = fresh(undefined, llm);
    const draft = await attachments.createDraft({
      bytes: new TextEncoder().encode("attachment notes"),
      originalName: "note.txt",
      mimeType: "text/plain",
    });

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "context-attachment-dedupe" },
      body: JSON.stringify({ input: "read attachment", attachmentIds: [draft.id] }),
    });

    expect(res.status).toBe(202);
    await waitFor(
      () => contexts.listSessionItems(c.id).filter((item) => item.role === "assistant").length,
      (length) => length > 0,
    );
    const matchingUserItems = contexts
      .listSessionItems(c.id)
      .filter((item) => item.role === "user" && JSON.stringify(item.item).includes("read attachment"));
    expect(matchingUserItems).toHaveLength(1);
    expect(JSON.stringify(matchingUserItems[0].item)).toContain(draft.id);
    cleanup();
  });

  test("startConversationRun stores context for session tools using the shared run path", async () => {
    const { convs, c, runs, msgs, attachments, contexts, cleanup } = fresh();
    const result = await startConversationRun(
      {
        conversations: convs,
        messages: msgs,
        attachments,
        runs,
        llm: fakeLlm,
        tools: async () => "noop",
        approvalQueue: new ApprovalQueue(),
        cancelSignals: new Map<string, AbortController>(),
        resumeRun: () => ({ status: "scheduled" }),
        contexts,
        systemPromptForAgent: () => "system",
        modelForAgent: () => "gpt-5.4",
        workspacePathForAgent: () => "",
      },
      { conversationId: c.id, input: "session tool send" },
    );

    await waitFor(() => runs.get(result.run.id), (run) => run?.status === "succeeded");
    expect(contexts.listSessionItems(c.id).filter((item) => item.role === "user")).toHaveLength(1);
    expect(contexts.listSessionItems(c.id).filter((item) => item.role === "assistant")).toHaveLength(1);
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs passes skills prompt as run context", async () => {
    const seenContextPrompts: Array<string | undefined> = [];
    const llm: LlmCallable = async function* (input): AsyncGenerator<LlmYield, void, unknown> {
      seenContextPrompts.push(input.contextPrompt);
      yield { kind: "final", text: "ok" };
    };
    const { app, c, cleanup } = fresh(
      undefined,
      llm,
      () => "\n\n<available_skills><skill><name>csv-insights</name></skill></available_skills>",
    );

    const response = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "skills" },
      body: JSON.stringify({ input: "test" }),
    });
    expect(response.status).toBe(202);

    for (let i = 0; i < 50 && seenContextPrompts.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(seenContextPrompts).toHaveLength(1);
    expect(seenContextPrompts[0]).toContain("<available_skills>");
    expect(seenContextPrompts[0]).toContain("csv-insights");
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs combines memory and skills context", async () => {
    const seenContextPrompts: Array<string | undefined> = [];
    const llm: LlmCallable = async function* (input): AsyncGenerator<LlmYield, void, unknown> {
      seenContextPrompts.push(input.contextPrompt);
      yield { kind: "final", text: "ok" };
    };
    const { app, c, cleanup } = fresh(
      undefined,
      llm,
      () => "\n\n<available_skills><skill><name>csv-insights</name></skill></available_skills>",
      async ({ agentId, input }) => {
        expect(agentId).toBe("local-work-agent");
        expect(input).toBe("remember project codename");
        return "\n\n<memories><memory id=\"mem-1\">Project codename is Vulture.</memory></memories>";
      },
    );

    const response = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "memory-skills" },
      body: JSON.stringify({ input: "remember project codename" }),
    });
    expect(response.status).toBe(202);

    for (let i = 0; i < 50 && seenContextPrompts.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(seenContextPrompts).toHaveLength(1);
    expect(seenContextPrompts[0]).toContain("<memories>");
    expect(seenContextPrompts[0]).toContain("Project codename is Vulture.");
    expect(seenContextPrompts[0]).toContain("<available_skills>");
    expect(seenContextPrompts[0]).toContain("csv-insights");
    expect(seenContextPrompts[0]!.indexOf("<memories>")).toBeLessThan(
      seenContextPrompts[0]!.indexOf("<available_skills>"),
    );
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs links uploaded attachments to the user message", async () => {
    const { app, c, msgs, attachments, cleanup } = fresh();
    const draft = await attachments.createDraft({
      bytes: new TextEncoder().encode("route attachment"),
      originalName: "route.txt",
      mimeType: "text/plain",
    });

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k-attachments" },
      body: JSON.stringify({ input: "read this", attachmentIds: [draft.id] }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.message.attachments.map((a: { id: string }) => a.id)).toEqual([draft.id]);
    expect(msgs.get(body.message.id)?.attachments.map((a) => a.displayName)).toEqual(["route.txt"]);

    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const run = await app.request(`/v1/runs/${body.run.id}`, { headers: auth });
      const status = ((await run.json()) as { status: string }).status;
      if (["succeeded", "failed", "cancelled"].includes(status)) break;
    }
    cleanup();
  });

  test("POST /v1/conversations/:cid/runs passes uploaded attachment bytes to the LLM", async () => {
    const seen: unknown[] = [];
    const llm: LlmCallable = mock(async function* (
      input: Parameters<LlmCallable>[0],
    ): AsyncGenerator<LlmYield, void, unknown> {
      seen.push(input.attachments);
      yield { kind: "final", text: "ok" };
    });
    const { app, c, attachments, cleanup } = fresh(undefined, llm);
    const draft = await attachments.createDraft({
      bytes: new TextEncoder().encode("hello llm"),
      originalName: "llm.txt",
      mimeType: "text/plain",
    });

    const res = await app.request(`/v1/conversations/${c.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k-llm-attachments" },
      body: JSON.stringify({ input: "read this", attachmentIds: [draft.id] }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const run = await app.request(`/v1/runs/${body.run.id}`, { headers: auth });
      const status = ((await run.json()) as { status: string }).status;
      if (["succeeded", "failed", "cancelled"].includes(status)) break;
    }

    expect(seen).toEqual([
      [
        {
          id: draft.id,
          kind: "file",
          displayName: "llm.txt",
          mimeType: "text/plain",
          sizeBytes: 9,
          dataBase64: "aGVsbG8gbGxt",
        },
      ],
    ]);
    cleanup();
  });

  test("GET /v1/conversations/:cid/runs?status=active returns queued/running runs", async () => {
    const { app, c, runs, msgs, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRunning(run.id);
    const queued = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });

    const res = await app.request(`/v1/conversations/${c.id}/runs?status=active`, {
      headers: auth,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; status: string }> };
    expect(body.items.map((item) => item.id)).toEqual([queued.id, run.id]);
    cleanup();
  });

  test("GET /v1/conversations/:cid/runs?status=recoverable returns recoverable runs", async () => {
    const { app, c, runs, msgs, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRecoverable(run.id);

    const res = await app.request(`/v1/conversations/${c.id}/runs?status=recoverable`, {
      headers: auth,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; status: string }> };
    expect(body.items.map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: run.id, status: "recoverable" },
    ]);
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
    const attachments = new AttachmentStore(db, dir);
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
      attachments,
      runs,
      llm: toolLlm,
      tools: async () => {
        toolCalled += 1;
        return { stdout: "hi" };
      },
      approvalQueue: new ApprovalQueue(),
      cancelSignals: new Map<string, AbortController>(),
      resumeRun: () => ({ status: "scheduled" as const }),
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

  test("POST /v1/runs/:rid/cancel marks recoverable run cancelled", async () => {
    const { app, c, runs, msgs, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRecoverable(run.id);

    const res = await app.request(`/v1/runs/${run.id}/cancel`, { method: "POST", headers: auth });

    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("cancelled");
    cleanup();
  });

  test("POST /v1/runs/:rid/resume schedules recoverable run", async () => {
    const { app, c, runs, msgs, resumeRun, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRecoverable(run.id);

    const res = await app.request(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      headers: auth,
    });

    expect(res.status).toBe(202);
    expect(resumeRun).toHaveBeenCalledWith(run.id, "manual");
    cleanup();
  });

  test("POST /v1/runs/:rid/resume rejects an already claimed run", async () => {
    const resumeRun = mock((_runId: string, _mode: "auto" | "manual") => ({
      status: "already_started" as const,
    }));
    const { app, c, runs, msgs, cleanup } = fresh(resumeRun);
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRecoverable(run.id);

    const res = await app.request(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      headers: auth,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "run.not_recoverable",
      message: "already started",
    });
    cleanup();
  });

  test("POST /v1/runs/:rid/resume rejects missing recovery state", async () => {
    const resumeRun = mock((_runId: string, _mode: "auto" | "manual") => ({
      status: "missing_state" as const,
    }));
    const { app, c, runs, msgs, cleanup } = fresh(resumeRun);
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRecoverable(run.id);

    const res = await app.request(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      headers: auth,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "internal.recovery_state_unavailable",
      message: `recovery state unavailable for ${run.id}`,
    });
    cleanup();
  });

  test("POST /v1/runs/:rid/resume rejects terminal run", async () => {
    const { app, c, runs, msgs, resumeRun, cleanup } = fresh();
    const userMsg = msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    const run = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markSucceeded(run.id, "m-result");

    const res = await app.request(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      headers: auth,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "run.not_recoverable", message: "succeeded" });
    expect(resumeRun).not.toHaveBeenCalled();
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
    const attachments = new AttachmentStore(db, dir);
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
      attachments,
      runs,
      llm: toolLlm,
      tools: fakeShellTools,
      approvalQueue,
      cancelSignals,
      resumeRun: () => ({ status: "scheduled" as const }),
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
    const attachments = new AttachmentStore(db, dir);
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
      attachments,
      runs,
      llm: fakeLlm,
      tools: async () => "noop",
      approvalQueue,
      cancelSignals: new Map(),
      resumeRun: () => ({ status: "scheduled" as const }),
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
    const attachments = new AttachmentStore(db, dir);
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
      attachments,
      runs,
      llm: fakeLlm,
      tools: async () => "noop",
      approvalQueue,
      cancelSignals,
      resumeRun: () => ({ status: "scheduled" as const }),
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
