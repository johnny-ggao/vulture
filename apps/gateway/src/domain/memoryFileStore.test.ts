import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AgentStore } from "./agentStore";
import { MemoryStore } from "./memoryStore";
import { MemoryFileStore } from "./memoryFileStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-memory-files-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const agents = new AgentStore(db, dir, undefined, dir);
  const agent = agents.get("local-work-agent");
  if (!agent) throw new Error("missing default agent");
  const legacy = new MemoryStore(db);
  const files = new MemoryFileStore({ db, legacy });
  return {
    dir,
    db,
    agent,
    legacy,
    files,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("MemoryFileStore", () => {
  test("initializeAgent creates MEMORY.md and memory directory", async () => {
    const { agent, files, cleanup } = fresh();

    await files.initializeAgent(agent);

    expect(existsSync(join(agent.workspace.path, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(agent.workspace.path, "memory"))).toBe(true);
    cleanup();
  });

  test("migrateLegacy appends DB memories to MEMORY.md exactly once", async () => {
    const { agent, legacy, files, cleanup } = fresh();
    legacy.create({
      agentId: agent.id,
      content: "Project codename is Vulture.",
      keywords: ["project", "codename", "vulture"],
      embedding: null,
    });

    await files.migrateLegacy(agent);
    await files.migrateLegacy(agent);

    const content = readFileSync(join(agent.workspace.path, "MEMORY.md"), "utf8");
    expect(content.match(/Project codename is Vulture/g)?.length).toBe(1);
    cleanup();
  });

  test("reindexAgent indexes markdown chunks and keyword search retrieves them", async () => {
    const { agent, files, cleanup } = fresh();
    await files.append(agent, "MEMORY.md", "## Project\n\nProject codename is Vulture.");

    const results = await files.search(agent, "项目代号 Vulture 是什么", 5);

    expect(results.map((result) => result.memory.content)).toContain(
      "Project\n\nProject codename is Vulture.",
    );
    cleanup();
  });

  test("append writes to MEMORY.md and reindexes the changed file", async () => {
    const { agent, files, cleanup } = fresh();

    const chunks = await files.append(agent, "MEMORY.md", "- User prefers concise Chinese answers.");

    expect(readFileSync(join(agent.workspace.path, "MEMORY.md"), "utf8")).toContain(
      "- User prefers concise Chinese answers.",
    );
    expect(chunks.some((chunk) => chunk.content.includes("concise Chinese"))).toBe(true);
    cleanup();
  });
});
