import type { DB } from "./sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const init001 = readFileSync(join(here, "migrations", "001_init.sql"), "utf8");
const init002 = readFileSync(join(here, "migrations", "002_runs.sql"), "utf8");
const init003 = readFileSync(join(here, "migrations", "003_run_recovery.sql"), "utf8");
const init004 = readFileSync(join(here, "migrations", "004_run_token_usage.sql"), "utf8");
const init005 = readFileSync(join(here, "migrations", "005_message_attachments.sql"), "utf8");
const init006 = readFileSync(join(here, "migrations", "006_agent_skills.sql"), "utf8");
const init007 = readFileSync(join(here, "migrations", "007_memories.sql"), "utf8");
const init008 = readFileSync(join(here, "migrations", "008_memory_files.sql"), "utf8");
const init009 = readFileSync(join(here, "migrations", "009_mcp_servers.sql"), "utf8");
const init010 = readFileSync(join(here, "migrations", "010_mcp_tool_policy.sql"), "utf8");
const init011 = readFileSync(join(here, "migrations", "011_conversation_context.sql"), "utf8");
const init012 = readFileSync(join(here, "migrations", "012_agent_tool_policy.sql"), "utf8");
const init013 = readFileSync(join(here, "migrations", "013_subagent_sessions.sql"), "utf8");
const init014 = readFileSync(join(here, "migrations", "014_agent_handoffs.sql"), "utf8");
const init015 = readFileSync(join(here, "migrations", "015_conversation_permission_mode.sql"), "utf8");

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  { version: 1, sql: init001 },
  { version: 2, sql: init002 },
  { version: 3, sql: init003 },
  { version: 4, sql: init004 },
  { version: 5, sql: init005 },
  { version: 6, sql: init006 },
  { version: 7, sql: init007 },
  { version: 8, sql: init008 },
  { version: 9, sql: init009 },
  { version: 10, sql: init010 },
  { version: 11, sql: init011 },
  { version: 12, sql: init012 },
  { version: 13, sql: init013 },
  { version: 14, sql: init014 },
  { version: 15, sql: init015 },
];

export function currentSchemaVersion(db: DB): number {
  const row = db
    .query("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}

export function applyMigrations(db: DB): void {
  for (const m of MIGRATIONS) {
    let v = 0;
    try {
      v = currentSchemaVersion(db);
    } catch {
      v = 0;
    }
    if (v < m.version) {
      db.exec(m.sql);
    }
  }
}
