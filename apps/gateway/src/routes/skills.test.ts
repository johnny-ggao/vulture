import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AgentStore } from "../domain/agentStore";
import { agentsRouter } from "./agents";
import { skillsRouter } from "./skills";

function writeSkill(root: string, dirName: string, body: { name: string; description: string }): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", `name: ${body.name}`, `description: ${body.description}`, "---", "", `# ${body.name}`, ""].join("\n"),
  );
}

function freshApp() {
  const dir = mkdtemp();
  const privateWorkspaces = join(dir, "workspace-home");
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const store = new AgentStore(db, dir, undefined, privateWorkspaces);
  const app = new Hono();
  app.route("/", agentsRouter(store));
  app.route("/", skillsRouter(store, dir));
  return {
    app,
    store,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "vulture-skills-route-"));
}

describe("/v1/skills", () => {
  test("lists loadable profile and workspace skills with per-agent enablement", async () => {
    const { app, store, dir, cleanup } = freshApp();
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeSkill(join(dir, "skills"), "csv", {
      name: "csv-insights",
      description: "Summarize CSV reports.",
    });
    const agent = store.get("local-work-agent");
    if (!agent) throw new Error("missing default agent");
    mkdirSync(join(agent.workspace.path, "skills"), { recursive: true });
    writeSkill(join(agent.workspace.path, "skills"), "repo", {
      name: "repo-notes",
      description: "Read repository notes.",
    });

    const res = await app.request("/v1/skills?agentId=local-work-agent");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe("local-work-agent");
    expect(body.policy).toBe("all");
    expect(body.allowlist).toBeUndefined();
    expect(body.items.map((item: { name: string }) => item.name)).toEqual([
      "csv-insights",
      "repo-notes",
    ]);
    expect(body.items).toContainEqual(
      expect.objectContaining({
        name: "csv-insights",
        description: "Summarize CSV reports.",
        source: "profile",
        enabled: true,
        modelInvocationEnabled: true,
      }),
    );
    expect(body.items).toContainEqual(
      expect.objectContaining({
        name: "repo-notes",
        description: "Read repository notes.",
        source: "workspace",
        enabled: true,
      }),
    );
    cleanup();
  });

  test("marks skills disabled when the agent allowlist is empty", async () => {
    const { app, dir, cleanup } = freshApp();
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeSkill(join(dir, "skills"), "csv", {
      name: "csv-insights",
      description: "Summarize CSV reports.",
    });

    await app.request("/v1/agents/local-work-agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skills: [] }),
    });
    const res = await app.request("/v1/skills?agentId=local-work-agent");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toBe("none");
    expect(body.allowlist).toEqual([]);
    expect(body.items).toEqual([
      expect.objectContaining({
        name: "csv-insights",
        enabled: false,
      }),
    ]);
    cleanup();
  });

  test("marks only allowlisted skills enabled", async () => {
    const { app, dir, cleanup } = freshApp();
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeSkill(join(dir, "skills"), "csv", {
      name: "csv-insights",
      description: "Summarize CSV reports.",
    });
    writeSkill(join(dir, "skills"), "writer", {
      name: "writer",
      description: "Draft polished copy.",
    });

    await app.request("/v1/agents/local-work-agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skills: ["writer"] }),
    });
    const res = await app.request("/v1/skills?agentId=local-work-agent");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toBe("allowlist");
    expect(body.allowlist).toEqual(["writer"]);
    expect(
      body.items.map((item: { name: string; enabled: boolean }) => [item.name, item.enabled]),
    ).toEqual([
      ["csv-insights", false],
      ["writer", true],
    ]);
    cleanup();
  });

  test("unknown agent returns 404", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/skills?agentId=missing");

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("agent.not_found");
    cleanup();
  });
});
