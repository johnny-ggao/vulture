import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { conversationsRouter } from "./conversations";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-conv-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const app = conversationsRouter({ conversations: convs, messages: msgs });
  return { app, convs, msgs, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
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

  test("DELETE → 204; subsequent GET messages → 404", async () => {
    const { app, convs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    const del = await app.request(`/v1/conversations/${c.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
    const list = await app.request(`/v1/conversations/${c.id}/messages`, { headers: auth });
    expect(list.status).toBe(404);
    cleanup();
  });
});
