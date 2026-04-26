import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./sqlite";

describe("openDatabase", () => {
  test("creates file, runs in WAL, passes integrity check", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-sqlite-"));
    const path = join(dir, "data.sqlite");
    const db = openDatabase(path);
    const journalMode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journalMode.journal_mode).toBe("wal");
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe("ok");
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("creates parent directory if missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-sqlite-"));
    const path = join(dir, "nested", "more", "data.sqlite");
    const db = openDatabase(path);
    const journalMode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journalMode.journal_mode).toBe("wal");
    db.close();
    rmSync(dir, { recursive: true });
  });
});
