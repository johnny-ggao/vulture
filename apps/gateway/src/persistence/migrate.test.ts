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
const LATEST_SCHEMA_VERSION = 14;

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

  test("007 adds memories table", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v7-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const columns = db
      .query("PRAGMA table_info(memories)")
      .all() as { name: string; notnull: number }[];
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "agent_id",
      "content",
      "embedding_json",
      "keywords_json",
      "created_at",
      "updated_at",
    ]);
    expect(columns.find((c) => c.name === "agent_id")?.notnull).toBe(1);
    expect(columns.find((c) => c.name === "embedding_json")?.notnull).toBe(0);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("008 adds file-first memory index tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v8-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const memoryFilesColumns = db
      .query("PRAGMA table_info(memory_files)")
      .all() as { name: string }[];
    const memoryChunksColumns = db
      .query("PRAGMA table_info(memory_chunks)")
      .all() as { name: string }[];
    const memorySuggestionsColumns = db
      .query("PRAGMA table_info(memory_suggestions)")
      .all() as { name: string }[];
    expect(memoryFilesColumns.map((c) => c.name)).toContain("content_hash");
    expect(memoryChunksColumns.map((c) => c.name)).toContain("embedding_json");
    expect(memorySuggestionsColumns.map((c) => c.name)).toContain("status");
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("009 adds MCP server config table", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v9-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const columns = db
      .query("PRAGMA table_info(mcp_servers)")
      .all() as { name: string; notnull: number }[];
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "profile_id",
      "name",
      "transport",
      "command",
      "args_json",
      "cwd",
      "env_json",
      "trust",
      "enabled",
      "created_at",
      "updated_at",
      "enabled_tools_json",
      "disabled_tools_json",
    ]);
    expect(columns.find((c) => c.name === "profile_id")?.notnull).toBe(1);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("012 adds agent tool preset policy columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v12-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const columns = db
      .query("PRAGMA table_info(agents)")
      .all() as { name: string; notnull: number }[];
    expect(columns.map((c) => c.name)).toContain("tool_preset");
    expect(columns.map((c) => c.name)).toContain("tool_include_json");
    expect(columns.map((c) => c.name)).toContain("tool_exclude_json");
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("013 adds durable subagent session table", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v13-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const columns = db
      .query("PRAGMA table_info(subagent_sessions)")
      .all() as { name: string; notnull: number }[];
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "parent_conversation_id",
      "parent_run_id",
      "agent_id",
      "conversation_id",
      "label",
      "status",
      "message_count",
      "created_at",
      "updated_at",
    ]);
    expect(columns.find((c) => c.name === "parent_conversation_id")?.notnull).toBe(1);
    expect(columns.find((c) => c.name === "parent_run_id")?.notnull).toBe(1);
    expect(columns.find((c) => c.name === "conversation_id")?.notnull).toBe(1);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("014 adds agent handoff configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v14-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const columns = db
      .query("PRAGMA table_info(agents)")
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const handoffColumn = columns.find((c) => c.name === "handoff_agent_ids_json");
    expect(handoffColumn?.notnull).toBe(1);
    expect(handoffColumn?.dflt_value).toBe("'[]'");
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("010 adds MCP tool visibility policy columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v10-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const columns = db
      .query("PRAGMA table_info(mcp_servers)")
      .all() as { name: string; notnull: number }[];
    expect(columns.map((c) => c.name)).toContain("enabled_tools_json");
    expect(columns.map((c) => c.name)).toContain("disabled_tools_json");
    expect(columns.find((c) => c.name === "enabled_tools_json")?.notnull).toBe(0);
    expect(columns.find((c) => c.name === "disabled_tools_json")?.notnull).toBe(1);
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("migration 11 creates conversation context tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-migrate-v11-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    const contextColumns = db
      .query("PRAGMA table_info(conversation_contexts)")
      .all() as Array<{ name: string }>;
    expect(contextColumns.map((column) => column.name)).toContain("conversation_id");
    expect(contextColumns.map((column) => column.name)).toContain("summary");
    expect(contextColumns.map((column) => column.name)).toContain(
      "summarized_through_message_id",
    );

    const itemColumns = db
      .query("PRAGMA table_info(conversation_session_items)")
      .all() as Array<{ name: string }>;
    expect(itemColumns.map((column) => column.name)).toContain("item_json");
    expect(itemColumns.map((column) => column.name)).toContain("message_id");

    const contextForeignKeys = db
      .query("PRAGMA foreign_key_list(conversation_contexts)")
      .all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
    expect(contextForeignKeys).toContainEqual(expect.objectContaining({
      table: "conversations",
      from: "conversation_id",
      to: "id",
      on_delete: "CASCADE",
    }));

    const itemForeignKeys = db
      .query("PRAGMA foreign_key_list(conversation_session_items)")
      .all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
    expect(itemForeignKeys).toContainEqual(expect.objectContaining({
      table: "conversations",
      from: "conversation_id",
      to: "id",
      on_delete: "CASCADE",
    }));

    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
    rmSync(dir, { recursive: true });
  });
});
