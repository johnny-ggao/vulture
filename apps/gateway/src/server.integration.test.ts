import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server";

const TOKEN = "x".repeat(43);

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-int-"));
  const app = buildServer({
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: process.pid,
    profileDir: dir,
    privateWorkspaceHomeDir: dir,
  });
  return { app, dir, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe("server integration (full stack)", () => {
  test("agent CRUD round-trip (default + create + get + delete)", async () => {
    const { app, cleanup } = makeServer();
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const list1 = await app.request("/v1/agents", { headers: auth });
    expect(list1.status).toBe(200);
    expect((await list1.json()).items.map((a: { id: string }) => a.id)).toEqual([
      "local-work-agent",
    ]);

    const create = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k1" },
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
    expect(create.status).toBe(201);

    const get = await app.request("/v1/agents/coder", { headers: auth });
    expect(get.status).toBe(200);

    const del = await app.request("/v1/agents/coder", { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);

    cleanup();
  });

  test("legacy file store auto-imports on first start, originals renamed to .bak", async () => {
    // Build the directory + legacy seed BEFORE invoking buildServer.
    const dir = mkdtempSync(join(tmpdir(), "vulture-int-import-"));
    const agentDir = join(dir, "agents", "imported");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "agent.json"),
      JSON.stringify({
        id: "imported",
        name: "Imported",
        description: "from disk",
        model: "gpt-5.4",
        reasoning: "medium",
        tools: [],
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      }),
    );
    writeFileSync(join(agentDir, "instructions.md"), "Imported instructions.");

    const app = buildServer({
      port: 4099,
      token: TOKEN,
      shellCallbackUrl: "http://127.0.0.1:4199",
      shellPid: process.pid,
      profileDir: dir,
      privateWorkspaceHomeDir: dir,
    });
    const list = await app.request("/v1/agents", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const items = (await list.json()).items;
    expect(items.find((a: { id: string }) => a.id === "imported")).toBeTruthy();

    const dirs = readdirSync(dir);
    expect(dirs.some((d) => d.startsWith("agents.bak."))).toBe(true);

    rmSync(dir, { recursive: true });
  });

  test("workspace CRUD round-trip with idempotency", async () => {
    const { app, dir, cleanup } = makeServer();
    const wsPath = join(dir, "ws-real");
    mkdirSync(wsPath);
    const auth = { Authorization: `Bearer ${TOKEN}` };

    const create = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ws-k1" },
      body: JSON.stringify({ id: "alpha", name: "Alpha", path: wsPath }),
    });
    expect(create.status).toBe(201);

    const list = await app.request("/v1/workspaces", { headers: auth });
    expect((await list.json()).items.map((w: { id: string }) => w.id)).toEqual(["alpha"]);

    cleanup();
  });

  test("profile GET + PATCH", async () => {
    const { app, cleanup } = makeServer();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const get1 = await app.request("/v1/profile", { headers: auth });
    expect((await get1.json()).id).toBe("default");
    const patch = await app.request("/v1/profile", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect((await patch.json()).name).toBe("Renamed");
    cleanup();
  });
});
