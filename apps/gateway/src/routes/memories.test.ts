import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AgentStore } from "../domain/agentStore";
import { MemoryStore } from "../domain/memoryStore";
import { agentsRouter } from "./agents";
import { memoriesRouter } from "./memories";

function freshApp(embed: (input: string) => Promise<number[] | null> = async () => null) {
  const dir = mkdtempSync(join(tmpdir(), "vulture-memory-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const agents = new AgentStore(db, dir, undefined, dir);
  agents.list();
  const memories = new MemoryStore(db);
  const app = new Hono();
  app.route("/", agentsRouter(agents));
  app.route("/", memoriesRouter({ agents, memories, embed }));
  return {
    app,
    memories,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("/v1/agents/:agentId/memories", () => {
  test("POST creates a memory and GET lists it without exposing embedding", async () => {
    const seenEmbeddingInputs: string[] = [];
    const { app, cleanup } = freshApp(async (input) => {
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
    expect(createdBody).toEqual({
      id: expect.stringMatching(/^mem-/),
      agentId: "local-work-agent",
      content: "Project codename is Vulture.",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(seenEmbeddingInputs).toEqual(["Project codename is Vulture."]);

    const listed = await app.request("/v1/agents/local-work-agent/memories");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ items: [createdBody] });
    cleanup();
  });

  test("DELETE removes only the requested agent memory", async () => {
    const { app, memories, cleanup } = freshApp();
    const target = memories.create({
      agentId: "local-work-agent",
      content: "Delete me.",
      keywords: ["delete", "me"],
      embedding: null,
    });

    const res = await app.request(`/v1/agents/local-work-agent/memories/${target.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(memories.list("local-work-agent")).toEqual([]);
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
