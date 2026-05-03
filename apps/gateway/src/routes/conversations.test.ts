import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { ConversationContextStore } from "../domain/conversationContextStore";
import { conversationsRouter } from "./conversations";
import type { AgentInputItem } from "@openai/agents";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-conv-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const contexts = new ConversationContextStore(db);
  const app = conversationsRouter({ conversations: convs, messages: msgs, contexts });
  return { app, convs, msgs, contexts, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("/v1/conversations", () => {
  test("POST creates with Idempotency-Key", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k1" },
      body: JSON.stringify({ agentId: "local-work-agent", title: "First" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).agentId).toBe("local-work-agent");
    cleanup();
  });

  test("POST can create a read-only conversation", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k-read-only" },
      body: JSON.stringify({
        agentId: "local-work-agent",
        title: "Read only",
        permissionMode: "read_only",
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).permissionMode).toBe("read_only");
    cleanup();
  });

  test("POST can create a smart-review conversation", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k-auto-review" },
      body: JSON.stringify({
        agentId: "local-work-agent",
        title: "Smart approval",
        permissionMode: "auto_review",
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).permissionMode).toBe("auto_review");
    cleanup();
  });

  test("PATCH updates the conversation permission mode", async () => {
    const { app, convs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });

    const res = await app.request(`/v1/conversations/${c.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "full_access" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).permissionMode).toBe("full_access");
    expect(convs.get(c.id)?.permissionMode).toBe("full_access");
    cleanup();
  });

  test("PATCH sets and clears the conversation working directory", async () => {
    const { app, convs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    expect(c.workingDirectory).toBeNull();

    const setRes = await app.request(`/v1/conversations/${c.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workingDirectory: "/Users/me/Code/proj" }),
    });
    expect(setRes.status).toBe(200);
    expect((await setRes.json()).workingDirectory).toBe("/Users/me/Code/proj");
    expect(convs.get(c.id)?.workingDirectory).toBe("/Users/me/Code/proj");

    const clearRes = await app.request(`/v1/conversations/${c.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ workingDirectory: null }),
    });
    expect(clearRes.status).toBe(200);
    expect((await clearRes.json()).workingDirectory).toBeNull();
    cleanup();
  });

  test("POST without Idempotency-Key → 400", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "x" }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });

  test("GET /:id/messages returns appended messages", async () => {
    const { app, convs, msgs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    msgs.append({ conversationId: c.id, role: "user", content: "hi", runId: null });
    msgs.append({ conversationId: c.id, role: "assistant", content: "yo", runId: null });
    const res = await app.request(`/v1/conversations/${c.id}/messages`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(2);
    cleanup();
  });

  test("GET unknown id → 404 conversation.not_found", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations/missing/messages", { headers: auth });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("conversation.not_found");
    cleanup();
  });

  test("GET /:id/context returns summary metadata", async () => {
    const { app, convs, contexts, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    contexts.addSessionItems(c.id, [
      {
        messageId: "m-1",
        role: "user",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        } as AgentInputItem,
      },
      {
        messageId: "m-2",
        role: "assistant",
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hi" }],
        } as AgentInputItem,
      },
    ]);
    contexts.upsertContext({
      conversationId: c.id,
      agentId: c.agentId,
      summary: "User is working on context management.",
      summarizedThroughMessageId: "m-1",
      inputItemCount: 2,
      inputCharCount: 42,
    });

    const res = await app.request(`/v1/conversations/${c.id}/context`, { headers: auth });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      conversationId: c.id,
      summary: "User is working on context management.",
      summarizedThroughMessageId: "m-1",
      rawItemCount: 2,
    });
    cleanup();
  });

  test("GET /:id/context returns empty defaults when no context exists", async () => {
    const { app, convs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });

    const res = await app.request(`/v1/conversations/${c.id}/context`, { headers: auth });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conversationId: c.id,
      summary: "",
      summarizedThroughMessageId: null,
      rawItemCount: 0,
      updatedAt: null,
    });
    cleanup();
  });

  test("GET /:id/context unknown id → 404 conversation.not_found", async () => {
    const { app, cleanup } = fresh();
    const res = await app.request("/v1/conversations/missing/context", { headers: auth });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("conversation.not_found");
    cleanup();
  });

  test("DELETE → 204; subsequent GET messages → 404", async () => {
    const { app, convs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    const del = await app.request(`/v1/conversations/${c.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
    const list = await app.request(`/v1/conversations/${c.id}/messages`, { headers: auth });
    expect(list.status).toBe(404);
    cleanup();
  });

  test("DELETE removes context and session rows", async () => {
    const { app, convs, contexts, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    contexts.addSessionItems(c.id, [
      {
        messageId: "m-1",
        role: "user",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        } as AgentInputItem,
      },
    ]);
    contexts.upsertContext({
      conversationId: c.id,
      agentId: c.agentId,
      summary: "summary",
      summarizedThroughMessageId: "m-1",
      inputItemCount: 1,
      inputCharCount: 5,
    });

    const res = await app.request(`/v1/conversations/${c.id}`, { method: "DELETE", headers: auth });

    expect(res.status).toBe(204);
    expect(contexts.getContext(c.id)).toBeNull();
    expect(contexts.listSessionItems(c.id)).toEqual([]);
    cleanup();
  });
});
