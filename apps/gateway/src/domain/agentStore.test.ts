import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandId } from "@vulture/common";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AgentStore } from "./agentStore";
import type { AgentId } from "@vulture/protocol/src/v1/agent";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-agent-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return {
    store: new AgentStore(db, dir),
    cleanup: () => { db.close(); rmSync(dir, { recursive: true }); },
  };
}

describe("AgentStore", () => {
  test("ensures default agent on first list", () => {
    const { store, cleanup } = freshStore();
    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(brandId<AgentId>("local-work-agent"));
    expect(list[0].instructions.length).toBeGreaterThan(0);
    cleanup();
  });

  test("default agent gets a private workspace under <root>/agents/<id>/workspace", () => {
    const { store, cleanup } = freshStore();
    const [agent] = store.list();
    expect(agent.workspace.id).toBe(brandId("local-work-agent-workspace"));
    expect(agent.workspace.path).toMatch(/agents\/local-work-agent\/workspace$/);
    cleanup();
  });

  test("save creates new agent", () => {
    const { store, cleanup } = freshStore();
    const saved = store.save({
      id: "coder",
      name: "Coder",
      description: "Writes code",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["shell.exec"],
      instructions: "Be careful.",
    });
    expect(saved.id).toBe(brandId<AgentId>("coder"));
    const ids = store.list().map((a) => a.id).sort((a, b) => (a < b ? -1 : 1));
    const expected = [brandId<AgentId>("coder"), brandId<AgentId>("local-work-agent")].sort((a, b) => (a < b ? -1 : 1));
    expect(ids).toEqual(expected);
    cleanup();
  });

  test("delete refuses last agent", () => {
    const { store, cleanup } = freshStore();
    store.list();
    expect(() => store.delete("local-work-agent")).toThrow(/last/i);
    cleanup();
  });

  test("delete removes non-last agent", () => {
    const { store, cleanup } = freshStore();
    store.save({
      id: "coder",
      name: "Coder",
      description: "x",
      model: "gpt-5.4",
      reasoning: "low",
      tools: [],
      instructions: "x",
    });
    store.delete("local-work-agent");
    const ids = store.list().map((a) => a.id);
    expect(ids).toEqual([brandId<AgentId>("coder")]);
    cleanup();
  });

  test("get returns null for unknown id", () => {
    const { store, cleanup } = freshStore();
    expect(store.get("nope")).toBeNull();
    cleanup();
  });
});
