import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AgentStore } from "./agentStore";
import { MemoryStore } from "./memoryStore";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-memory-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const agents = new AgentStore(db, dir, undefined, dir);
  agents.list();
  agents.save({
    id: "agent-b",
    name: "Agent B",
    description: "Second agent",
    model: "gpt-5.4",
    reasoning: "medium",
    tools: [],
    instructions: "Be useful.",
  });
  return {
    store: new MemoryStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("MemoryStore", () => {
  test("create stores keywords and list returns newest first for an agent", () => {
    const { store, cleanup } = freshStore();

    const older = store.create({
      agentId: "local-work-agent",
      content: "User prefers concise Chinese answers.",
      keywords: ["user", "prefers", "concise", "chinese", "answers"],
      embedding: [0.1, 0.2],
    });
    const newer = store.create({
      agentId: "local-work-agent",
      content: "Project codename is Vulture.",
      keywords: ["project", "codename", "vulture"],
      embedding: null,
    });
    store.create({
      agentId: "agent-b",
      content: "Other agent memory.",
      keywords: ["other"],
      embedding: null,
    });

    expect(older.id).toStartWith("mem-");
    expect(store.list("local-work-agent").map((memory) => memory.id)).toEqual([newer.id, older.id]);
    expect(store.list("local-work-agent")[0]).toEqual({
      id: newer.id,
      agentId: "local-work-agent",
      content: "Project codename is Vulture.",
      keywords: ["project", "codename", "vulture"],
      embedding: null,
      createdAt: newer.createdAt,
      updatedAt: newer.updatedAt,
    });
    cleanup();
  });

  test("delete removes only memory owned by the requested agent", () => {
    const { store, cleanup } = freshStore();
    const target = store.create({
      agentId: "local-work-agent",
      content: "Remember this.",
      keywords: ["remember", "this"],
      embedding: null,
    });
    const other = store.create({
      agentId: "agent-b",
      content: "Do not delete this.",
      keywords: ["delete"],
      embedding: null,
    });

    expect(store.delete("agent-b", target.id)).toBe(false);
    expect(store.delete("local-work-agent", target.id)).toBe(true);
    expect(store.list("local-work-agent")).toEqual([]);
    expect(store.list("agent-b").map((memory) => memory.id)).toEqual([other.id]);
    cleanup();
  });
});
