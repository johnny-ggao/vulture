import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AgentStore } from "../domain/agentStore";
import { MemoryStore } from "../domain/memoryStore";
import { MemoryFileStore } from "../domain/memoryFileStore";
import { agentsRouter } from "./agents";
import { memoriesRouter } from "./memories";

function freshApp(embed: (input: string) => Promise<number[] | null> = async () => null) {
  const dir = mkdtempSync(join(tmpdir(), "vulture-memory-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const agents = new AgentStore(db, dir, undefined, dir);
  agents.list();
  const memories = new MemoryStore(db);
  const memoryFiles = new MemoryFileStore({ db, legacy: memories, embed });
  const app = new Hono();
  app.route("/", agentsRouter(agents));
  app.route("/", memoriesRouter({ agents, memories, memoryFiles, embed }));
  return {
    dir,
    app,
    memories,
    agents,
    memoryFiles,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("/v1/agents/:agentId/memories", () => {
  test("POST appends to MEMORY.md and GET lists indexed memory chunks", async () => {
    const seenEmbeddingInputs: string[] = [];
    const { app, agents, cleanup } = freshApp(async (input) => {
      seenEmbeddingInputs.push(input);
      return [0.25, 0.75];
    });
    const created = await app.request("/v1/agents/local-work-agent/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "mem-1" },
      body: JSON.stringify({ content: "Project codename is Vulture." }),
    });

    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      id: expect.stringMatching(/^memchunk-/),
      agentId: "local-work-agent",
      content: "Project codename is Vulture.",
      path: "MEMORY.md",
      updatedAt: expect.any(String),
    });
    expect(seenEmbeddingInputs).toEqual(["Project codename is Vulture."]);
    expect(readFileSync(join(agents.get("local-work-agent")!.workspace.path, "MEMORY.md"), "utf8"))
      .toContain("Project codename is Vulture.");

    const listed = await app.request("/v1/agents/local-work-agent/memories");
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.items).toHaveLength(1);
    expect(listedBody.items[0]).toMatchObject({
      id: createdBody.id,
      agentId: "local-work-agent",
      content: "Project codename is Vulture.",
      path: "MEMORY.md",
    });
    cleanup();
  });

  test("DELETE returns conflict for file-backed memory chunks", async () => {
    const { app, cleanup } = freshApp();
    const created = await app.request("/v1/agents/local-work-agent/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "mem-delete" },
      body: JSON.stringify({ content: "Delete requires a file edit." }),
    });
    const target = await created.json();

    const res = await app.request(`/v1/agents/local-work-agent/memories/${target.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("memory.file_backed");
    cleanup();
  });

  test("unknown agent returns 404", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents/missing/memories");

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("agent.not_found");
    cleanup();
  });

  test("POST rejects empty content", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents/local-work-agent/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "mem-empty" },
      body: JSON.stringify({ content: "   " }),
    });

    expect(res.status).toBe(400);
    cleanup();
  });
});
