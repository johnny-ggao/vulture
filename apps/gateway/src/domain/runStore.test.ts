import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "./conversationStore";
import { MessageStore } from "./messageStore";
import { RunStore } from "./runStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-run-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const c = convs.create({ agentId: "a-1" });
  const userMsg = msgs.append({
    conversationId: c.id,
    role: "user",
    content: "hi",
    runId: null,
  });
  return { db, runs, c, userMsg, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("RunStore", () => {
  test("create + get + transition to succeeded", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    expect(r.status).toBe("queued");
    runs.markRunning(r.id);
    expect(runs.get(r.id)?.status).toBe("running");
    runs.markSucceeded(r.id, "m-result");
    const final = runs.get(r.id)!;
    expect(final.status).toBe("succeeded");
    expect(final.resultMessageId as string).toBe("m-result");
    cleanup();
  });

  test("markFailed records error_json", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markFailed(r.id, { code: "internal", message: "boom" });
    const final = runs.get(r.id)!;
    expect(final.status).toBe("failed");
    expect(final.error?.code).toBe("internal");
    cleanup();
  });

  test("recoverInflightOnStartup sweeps queued/running → failed", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRunning(r.id);
    const fresh2 = new RunStore(db);
    const swept = fresh2.recoverInflightOnStartup();
    expect(swept).toBe(1);
    expect(runs.get(r.id)?.status).toBe("failed");
    expect(runs.get(r.id)?.error?.code).toBe("internal.gateway_restarted");
    cleanup();
  });

  test("appendEvent + listEventsAfter (in-memory + persisted)", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.appendEvent(r.id, { type: "run.started", agentId: c.agentId, model: "gpt-5.4" });
    runs.appendEvent(r.id, { type: "text.delta", text: "hello " });
    const all = runs.listEventsAfter(r.id, -1);
    expect(all.length).toBe(2);
    expect(all[0].seq).toBe(0);
    const after = runs.listEventsAfter(r.id, 0);
    expect(after.length).toBe(1);
    expect(after[0].type).toBe("text.delta");
    cleanup();
  });
});
