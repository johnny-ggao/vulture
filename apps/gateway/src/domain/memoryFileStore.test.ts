import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  test("reindexAgent records a failed file status instead of throwing", async () => {
    const { agent, files, cleanup } = fresh();
    mkdirSync(join(agent.workspace.path, "MEMORY.md"), { recursive: true });

    await expect(files.reindexAgent(agent)).resolves.toBeUndefined();

    expect(files.listFiles(agent.id)).toEqual([
      expect.objectContaining({
        path: "MEMORY.md",
        status: "failed",
        errorMessage: expect.any(String),
      }),
    ]);
    expect(files.listChunks(agent.id)).toEqual([]);
    cleanup();
  });

  test("suggestions can be accepted into MEMORY.md or dismissed", async () => {
    const { agent, files, cleanup } = fresh();
    const suggestion = files.createSuggestion({
      agentId: agent.id,
      runId: "r-1",
      conversationId: "c-1",
      content: "User prefers answers in Chinese.",
      reason: "The user explicitly requested Chinese replies.",
      targetPath: "MEMORY.md",
    });

    expect(files.listSuggestions(agent.id, "pending").map((item) => item.id)).toEqual([
      suggestion.id,
    ]);

    const accepted = await files.acceptSuggestion(agent, suggestion.id);
    expect(accepted.status).toBe("accepted");
    expect(readFileSync(join(agent.workspace.path, "MEMORY.md"), "utf8")).toContain(
      "User prefers answers in Chinese.",
    );
    expect(files.search(agent, "Chinese replies", 5)).resolves.toHaveLength(1);

    const dismissed = files.createSuggestion({
      agentId: agent.id,
      runId: "r-2",
      conversationId: "c-1",
      content: "Temporary note.",
      reason: "Only for this turn.",
      targetPath: "MEMORY.md",
    });
    expect(files.dismissSuggestion(agent.id, dismissed.id).status).toBe("dismissed");
    expect(files.listSuggestions(agent.id, "pending")).toEqual([]);
    cleanup();
  });
});
