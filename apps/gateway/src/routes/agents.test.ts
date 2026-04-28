import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AgentStore } from "../domain/agentStore";
import { agentsRouter } from "./agents";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-agent-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const app = agentsRouter(new AgentStore(db, dir, undefined, dir));
  return { app, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("/v1/agents", () => {
  test("GET seeds and returns local-work-agent", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents", { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((a: { id: string }) => a.id)).toEqual(["local-work-agent"]);
    cleanup();
  });

  test("POST creates new agent (with Idempotency-Key)", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ka1" },
      body: JSON.stringify({
        id: "coder",
        name: "Coder",
        description: "x",
        model: "gpt-5.4",
        reasoning: "low",
        tools: [],
        instructions: "x",
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe("coder");
    cleanup();
  });

  test("PATCH preserves requested workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vulture-agent-route-workspace-"));
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents/local-work-agent", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: {
          id: "repo",
          name: "Repo",
          path: workspace,
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace.path).toBe(workspace);
    expect(body.workspace.id).toBe("repo");
    cleanup();
    rmSync(workspace, { recursive: true });
  });

  test("PATCH persists empty skills allowlist", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents/local-work-agent", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ skills: [] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).skills).toEqual([]);

    const get = await app.request("/v1/agents/local-work-agent", { headers: auth });
    expect((await get.json()).skills).toEqual([]);
    cleanup();
  });

  test("PATCH clears skills allowlist with null", async () => {
    const { app, cleanup } = freshApp();
    await app.request("/v1/agents/local-work-agent", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ skills: ["csv-insights"] }),
    });

    const res = await app.request("/v1/agents/local-work-agent", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ skills: null }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).skills).toBeUndefined();

    const get = await app.request("/v1/agents/local-work-agent", { headers: auth });
    expect((await get.json()).skills).toBeUndefined();
    cleanup();
  });

  test("POST without Idempotency-Key → 400", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "coder", name: "C", description: "x", model: "gpt-5.4",
        reasoning: "low", tools: [], instructions: "x",
      }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });

  test("DELETE last agent → 409 agent.cannot_delete_last", async () => {
    const { app, cleanup } = freshApp();
    await app.request("/v1/agents", { headers: auth });
    const res = await app.request("/v1/agents/local-work-agent", {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("agent.cannot_delete_last");
    cleanup();
  });

  test("GET unknown id → 404 agent.not_found", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents/missing", { headers: auth });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("agent.not_found");
    cleanup();
  });

  test("POST with bad reasoning → 400 (schema)", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ka2" },
      body: JSON.stringify({
        id: "z", name: "Z", description: "z", model: "g", reasoning: "extreme",
        tools: [], instructions: "z",
      }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });
});
