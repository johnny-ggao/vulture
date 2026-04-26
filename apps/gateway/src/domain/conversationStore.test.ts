import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandId } from "@vulture/common";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "./conversationStore";
import type { AgentId } from "@vulture/protocol/src/v1/agent";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-conv-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return { store: new ConversationStore(db), cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("ConversationStore", () => {
  test("create + get + list", () => {
    const { store, cleanup } = freshStore();
    const c = store.create({ agentId: "a-1", title: "Hello" });
    expect(c.agentId).toBe(brandId<AgentId>("a-1"));
    expect(store.get(c.id)?.id).toBe(c.id);
    expect(store.list().map((x) => x.id)).toEqual([c.id]);
    cleanup();
  });

  test("list filters by agentId", () => {
    const { store, cleanup } = freshStore();
    store.create({ agentId: "a-1", title: "x" });
    store.create({ agentId: "a-2", title: "y" });
    expect(store.list({ agentId: "a-1" }).length).toBe(1);
    cleanup();
  });

  test("delete cascades (no orphan messages)", () => {
    const { store, cleanup } = freshStore();
    const c = store.create({ agentId: "a-1", title: "x" });
    store.delete(c.id);
    expect(store.get(c.id)).toBeNull();
    cleanup();
  });

  test("default title is empty string when not given", () => {
    const { store, cleanup } = freshStore();
    const c = store.create({ agentId: "a-1" });
    expect(c.title).toBe("");
    cleanup();
  });
});
