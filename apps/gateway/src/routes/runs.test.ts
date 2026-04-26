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
    systemPromptForAgent: () => "system",
    modelForAgent: () => "gpt-5.4",
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
});
