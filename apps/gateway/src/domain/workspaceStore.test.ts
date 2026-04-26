import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { WorkspaceStore } from "./workspaceStore";
import type { WorkspaceId } from "@vulture/protocol/src/v1/workspace";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-ws-store-"));
  const wsDir = join(dir, "ws");
  mkdirSync(wsDir);
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return {
    store: new WorkspaceStore(db),
    wsDir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

describe("WorkspaceStore", () => {
  test("save / list / delete round trip", () => {
    const { store, wsDir, cleanup } = freshStore();
    const w = store.save({ id: "ws-a", name: "Alpha", path: wsDir });
    expect(w.id).toBe("ws-a" as WorkspaceId);
    expect(w.name).toBe("Alpha");
    expect(store.list().map((x) => x.id)).toEqual(["ws-a" as WorkspaceId]);
    store.delete("ws-a");
    expect(store.list()).toEqual([]);
    cleanup();
  });

  test("save replaces existing row (same id)", () => {
    const { store, wsDir, cleanup } = freshStore();
    store.save({ id: "ws-a", name: "Alpha", path: wsDir });
    const updated = store.save({ id: "ws-a", name: "Alpha v2", path: wsDir });
    expect(updated.name).toBe("Alpha v2");
    expect(store.list()).toHaveLength(1);
    cleanup();
  });

  test("save throws when path does not exist", () => {
    const { store, cleanup } = freshStore();
    expect(() =>
      store.save({ id: "ws-bad", name: "Bad", path: "/no/such/dir" }),
    ).toThrow(/path/);
    cleanup();
  });

  test("delete unknown id is a no-op", () => {
    const { store, cleanup } = freshStore();
    store.delete("nope");
    expect(store.list()).toEqual([]);
    cleanup();
  });
});
