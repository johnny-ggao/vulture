import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./sqlite";
import { applyMigrations, currentSchemaVersion } from "./migrate";

describe("migrate", () => {
  test("applies 001_init and reports version 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(2);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("agents");
    expect(names).toContain("profile");
    expect(names).toContain("schema_version");
    expect(names).toContain("workspaces");
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("idempotent: applying twice does not fail or duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(2);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("002 adds conversations/messages/runs/run_events tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v2-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(2);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("conversations");
    expect(names).toContain("messages");
    expect(names).toContain("runs");
    expect(names).toContain("run_events");
    db.close();
    rmSync(dir, { recursive: true });
  });
});
