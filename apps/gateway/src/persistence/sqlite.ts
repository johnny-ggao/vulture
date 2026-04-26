import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database;

export function openDatabase(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
  if (integrity.integrity_check !== "ok") {
    db.close();
    throw new Error(`sqlite integrity_check failed: ${String(integrity.integrity_check)}`);
  }
  return db;
}
