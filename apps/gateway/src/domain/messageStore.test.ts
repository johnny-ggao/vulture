import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { MessageStore } from "./messageStore";
import { ConversationStore } from "./conversationStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-msg-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return {
    db,
    convs: new ConversationStore(db),
    msgs: new MessageStore(db),
    cleanup: () => { db.close(); rmSync(dir, { recursive: true }); },
  };
}

describe("MessageStore", () => {
  test("append + listSince", () => {
    const { convs, msgs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    const m1 = msgs.append({ conversationId: c.id, role: "user", content: "hi", runId: null });
    const m2 = msgs.append({ conversationId: c.id, role: "assistant", content: "yo", runId: null });
    const all = msgs.listSince({ conversationId: c.id });
    expect(all.map((m) => m.id)).toEqual([m1.id, m2.id]);
    const after = msgs.listSince({ conversationId: c.id, afterMessageId: m1.id });
    expect(after.map((m) => m.id)).toEqual([m2.id]);
    cleanup();
  });

  test("CASCADE delete removes messages when conversation is deleted", () => {
    const { convs, msgs, cleanup } = fresh();
    const c = convs.create({ agentId: "a-1" });
    msgs.append({ conversationId: c.id, role: "user", content: "x", runId: null });
    convs.delete(c.id);
    expect(msgs.listSince({ conversationId: c.id }).length).toBe(0);
    cleanup();
  });
});
