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
  test("GET seeds and returns both preset agents", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents", { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((a: { id: string }) => a.id).sort()).toEqual(["coding-agent", "local-work-agent"]);
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
    const body = await res.json();
    expect(body.id).toBe("coder");
    expect(body.description).toBe("x");
    expect(body.model).toBe("openai/gpt-5.4");
    expect(body.reasoning).toBe("low");
    cleanup();
  });

  test("POST accepts tool preset policy", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ka-policy" },
      body: JSON.stringify({
        id: "coder",
        name: "Coder",
        description: "x",
        model: "gpt-5.4",
        reasoning: "low",
        toolPreset: "developer",
        toolExclude: ["browser.click"],
        instructions: "x",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.toolPreset).toBe("developer");
    expect(body.toolExclude).toEqual(["browser.click"]);
    expect(body.tools).toContain("shell.exec");
    expect(body.tools).not.toContain("browser.click");
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
    // Use a custom (non-preset) agent — preset fields are force-overwritten on every reconcile pass.
    const { app, cleanup } = freshApp();
    await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ka-skills-empty" },
      body: JSON.stringify({
        id: "custom-skills",
        name: "Custom Skills",
        description: "x",
        model: "gpt-5.4",
        reasoning: "low",
        tools: [],
        instructions: "x",
      }),
    });

    const res = await app.request("/v1/agents/custom-skills", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ skills: [] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).skills).toEqual([]);

    const get = await app.request("/v1/agents/custom-skills", { headers: auth });
    expect((await get.json()).skills).toEqual([]);
    cleanup();
  });

  test("PATCH persists handoff agent ids", async () => {
    // Use a custom (non-preset) agent — preset fields are force-overwritten on every reconcile pass.
    const { app, cleanup } = freshApp();
    await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ka-researcher" },
      body: JSON.stringify({
        id: "researcher",
        name: "Researcher",
        description: "x",
        model: "gpt-5.4",
        reasoning: "medium",
        tools: [],
        instructions: "x",
      }),
    });

    await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ka-custom-handoff" },
      body: JSON.stringify({
        id: "custom-handoff",
        name: "Custom Handoff",
        description: "x",
        model: "gpt-5.4",
        reasoning: "low",
        tools: [],
        instructions: "x",
      }),
    });

    const res = await app.request("/v1/agents/custom-handoff", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ handoffAgentIds: ["researcher"] }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).handoffAgentIds).toEqual(["researcher"]);
    const get = await app.request("/v1/agents/custom-handoff", { headers: auth });
    expect((await get.json()).handoffAgentIds).toEqual(["researcher"]);
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

  test("agent core files can be listed, read, and updated", async () => {
    const { app, cleanup } = freshApp();
    const list = await app.request("/v1/agents/local-work-agent/files", { headers: auth });
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.files.map((file: { name: string }) => file.name)).toContain("SOUL.md");
    expect(listed.corePath).toContain("agent-core");

    const get = await app.request("/v1/agents/local-work-agent/files/SOUL.md", { headers: auth });
    expect(get.status).toBe(200);
    expect((await get.json()).file.content).toContain("Vulture");

    const put = await app.request("/v1/agents/local-work-agent/files/TOOLS.md", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Tool notes\n" }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).file.content).toBe("# Tool notes\n");
    cleanup();
  });

  test("agent core files reject unsupported names", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents/local-work-agent/files/profile.jsonc", {
      headers: auth,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("agent.file_unsupported");
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

  // NOTE: "DELETE last agent → 409 agent.cannot_delete_last" guard exists in AgentStore as a
  // defensive check, but is unreachable through HTTP because both presets self-heal on every
  // ensureDefaults() call (Decision #7). The guard remains in place for in-process callers.

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

  test("GET /v1/agents returns isPrivateWorkspace: true for freshly seeded coding-agent", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents", { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    const codingAgent = body.items.find((a: { id: string }) => a.id === "coding-agent");
    expect(codingAgent).toBeDefined();
    expect(codingAgent.isPrivateWorkspace).toBe(true);
    cleanup();
  });

  test("GET /v1/agents/:id returns isPrivateWorkspace: true for freshly seeded coding-agent", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/agents/coding-agent", { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isPrivateWorkspace).toBe(true);
    cleanup();
  });
});
