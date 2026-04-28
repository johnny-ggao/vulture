import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  test("status reports file-backed memory root and POST reindex refreshes chunks", async () => {
    const { app, agents, cleanup } = freshApp();
    const initial = await app.request("/v1/agents/local-work-agent/memories/status");

    expect(initial.status).toBe(200);
    const initialBody = await initial.json();
    expect(initialBody).toMatchObject({
      agentId: "local-work-agent",
      rootPath: agents.get("local-work-agent")!.workspace.path,
      fileCount: 1,
      chunkCount: 0,
      indexedAt: expect.any(String),
    });
    expect(initialBody.files).toEqual([
      expect.objectContaining({
        path: "MEMORY.md",
        status: "indexed",
      }),
    ]);

    const memoryPath = join(agents.get("local-work-agent")!.workspace.path, "MEMORY.md");
    await Bun.write(memoryPath, "# Memory\n\nProject codename is Vulture.\n");

    const reindexed = await app.request("/v1/agents/local-work-agent/memories/reindex", {
      method: "POST",
    });

    expect(reindexed.status).toBe(200);
    const body = await reindexed.json();
    expect(body.chunkCount).toBe(1);
    expect(body.files[0]).toMatchObject({
      path: "MEMORY.md",
      status: "indexed",
    });
    cleanup();
  });

  test("status and list return file failure state instead of 500 when indexing fails", async () => {
    const { app, agents, memories, cleanup } = freshApp();
    const agent = agents.get("local-work-agent")!;
    memories.create({
      agentId: agent.id,
      content: "Legacy memory cannot migrate into a directory.",
      keywords: ["legacy"],
      embedding: null,
    });
    mkdirSync(join(agent.workspace.path, "MEMORY.md"), { recursive: true });

    const status = await app.request("/v1/agents/local-work-agent/memories/status");
    expect(status.status).toBe(200);
    expect((await status.json()).files[0]).toMatchObject({
      path: "MEMORY.md",
      status: "failed",
      errorMessage: expect.any(String),
    });

    const listed = await app.request("/v1/agents/local-work-agent/memories");
    expect(listed.status).toBe(200);
    expect((await listed.json()).items).toEqual([]);
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

  test("suggestions can be listed, accepted, and dismissed", async () => {
    const { app, agents, memoryFiles, cleanup } = freshApp();
    const agent = agents.get("local-work-agent")!;
    const accept = memoryFiles.createSuggestion({
      agentId: agent.id,
      runId: "r-accept",
      conversationId: "c-1",
      content: "Project codename is Vulture.",
      reason: "User confirmed the project codename.",
      targetPath: "MEMORY.md",
    });
    const dismiss = memoryFiles.createSuggestion({
      agentId: agent.id,
      runId: "r-dismiss",
      conversationId: "c-1",
      content: "Temporary detail.",
      reason: "Not durable.",
      targetPath: "MEMORY.md",
    });

    const listed = await app.request("/v1/agents/local-work-agent/memory-suggestions");
    expect(listed.status).toBe(200);
    expect((await listed.json()).items.map((item: { id: string }) => item.id)).toEqual([
      dismiss.id,
      accept.id,
    ]);

    const accepted = await app.request(
      `/v1/agents/local-work-agent/memory-suggestions/${accept.id}/accept`,
      { method: "POST" },
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).status).toBe("accepted");
    expect(readFileSync(join(agent.workspace.path, "MEMORY.md"), "utf8")).toContain(
      "Project codename is Vulture.",
    );

    const dismissed = await app.request(
      `/v1/agents/local-work-agent/memory-suggestions/${dismiss.id}/dismiss`,
      { method: "POST" },
    );
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json()).status).toBe("dismissed");

    const pending = await app.request("/v1/agents/local-work-agent/memory-suggestions");
    expect((await pending.json()).items).toEqual([]);
    cleanup();
  });
});
