import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./sqlite";
import { applyMigrations, currentSchemaVersion } from "./migrate";

const here = dirname(fileURLToPath(import.meta.url));
const init001 = readFileSync(join(here, "migrations", "001_init.sql"), "utf8");
const init002 = readFileSync(join(here, "migrations", "002_runs.sql"), "utf8");
const LATEST_SCHEMA_VERSION = 6;

describe("migrate", () => {
  test("applies all migrations and reports latest version", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
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
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("full bootstrap includes conversations/messages/runs/run_events tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v2-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
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

  test("003 adds run_recovery_state table", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v3-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("run_recovery_state");
    const columns = db
      .query("PRAGMA table_info(run_recovery_state)")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual([
      "run_id",
      "schema_version",
      "sdk_state",
      "metadata_json",
      "checkpoint_seq",
      "active_tool_json",
      "updated_at",
    ]);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("upgrades an existing version 2 database to latest schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v2-to-v3-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    db.exec(init001);
    db.exec(init002);
    expect(currentSchemaVersion(db)).toBe(2);
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("run_recovery_state");
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("004 adds run token usage columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v4-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const columns = db
      .query("PRAGMA table_info(runs)")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("input_tokens");
    expect(columns.map((c) => c.name)).toContain("output_tokens");
    expect(columns.map((c) => c.name)).toContain("total_tokens");
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("005 adds attachment metadata tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v5-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("blobs");
    expect(names).toContain("message_attachments");
    const attachmentColumns = db
      .query("PRAGMA table_info(message_attachments)")
      .all() as { name: string; notnull: number }[];
    expect(attachmentColumns.map((c) => c.name)).toEqual([
      "id",
      "message_id",
      "blob_id",
      "kind",
      "display_name",
      "created_at",
    ]);
    expect(attachmentColumns.find((c) => c.name === "message_id")?.notnull).toBe(0);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("006 adds optional agent skills column", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v6-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const columns = db
      .query("PRAGMA table_info(agents)")
      .all() as { name: string; notnull: number }[];
    expect(columns.map((c) => c.name)).toContain("skills");
    expect(columns.find((c) => c.name === "skills")?.notnull).toBe(0);
    db.close();
    rmSync(dir, { recursive: true });
  });
});
