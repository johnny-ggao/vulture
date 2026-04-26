import type { DB } from "./sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const init001 = readFileSync(join(here, "migrations", "001_init.sql"), "utf8");

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [{ version: 1, sql: init001 }];

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
