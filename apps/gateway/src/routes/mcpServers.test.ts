import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { McpServerStore } from "../domain/mcpServerStore";
import { mcpServersRouter } from "./mcpServers";

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-mcp-routes-"));
  const cwd = join(dir, "server");
  mkdirSync(cwd);
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const store = new McpServerStore(db);
  const app = mcpServersRouter({
    store,
    runtime: {
      status: (id) => ({
        status: id === "echo" ? "connected" : "disconnected",
        lastError: null,
        toolCount: id === "echo" ? 1 : 0,
        updatedAt: "2026-04-28T00:00:00.000Z",
      }),
      reconnect: async () => undefined,
      tools: async () => [{ name: "echo", description: "Echo input" }],
    },
  });
  return {
    app,
    cwd,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

describe("/v1/mcp/servers routes", () => {
  test("creates and lists server configs with status", async () => {
    const { app, cwd, cleanup } = freshApp();

    const created = await app.request("/v1/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "echo",
        name: "Echo",
        transport: "stdio",
        command: "bun",
        args: ["run", "server.ts"],
        cwd,
        env: { EXAMPLE: "1" },
        trust: "ask",
        enabled: true,
      }),
    });

    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.id).toBe("echo");
    expect(body.runtime.status).toBe("connected");

    const listed = await app.request("/v1/mcp/servers");
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].runtime.toolCount).toBe(1);
    cleanup();
  });

  test("updates and deletes server configs", async () => {
    const { app, cleanup } = freshApp();
    await app.request("/v1/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "echo",
        name: "Echo",
        transport: "stdio",
        command: "bun",
        trust: "ask",
      }),
    });

    const updated = await app.request("/v1/mcp/servers/echo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trust: "trusted", enabled: false }),
    });
    expect(updated.status).toBe(200);
    const updateBody = await updated.json();
    expect(updateBody.trust).toBe("trusted");
    expect(updateBody.enabled).toBe(false);

    const deleted = await app.request("/v1/mcp/servers/echo", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const listed = await app.request("/v1/mcp/servers");
    expect((await listed.json()).items).toEqual([]);
    cleanup();
  });

  test("updates MCP tool visibility policy and marks listed tools", async () => {
    const { app, cleanup } = freshApp();
    await app.request("/v1/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "echo",
        name: "Echo",
        transport: "stdio",
        command: "bun",
        trust: "ask",
      }),
    });

    const updated = await app.request("/v1/mcp/servers/echo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabledTools: ["echo"], disabledTools: ["write_file"] }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      enabledTools: ["echo"],
      disabledTools: ["write_file"],
    });

    const tools = await app.request("/v1/mcp/servers/echo/tools");
    expect((await tools.json()).items).toEqual([
      { name: "echo", description: "Echo input", enabled: true },
    ]);
    cleanup();
  });

  test("rejects invalid config", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "bad",
        name: "Bad",
        transport: "stdio",
        command: "",
        trust: "ask",
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("command is required");
    cleanup();
  });

  test("reconnects and lists tools", async () => {
    const { app, cleanup } = freshApp();
    await app.request("/v1/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "echo",
        name: "Echo",
        transport: "stdio",
        command: "bun",
        trust: "ask",
      }),
    });

    const reconnect = await app.request("/v1/mcp/servers/echo/reconnect", { method: "POST" });
    expect(reconnect.status).toBe(200);
    expect((await reconnect.json()).runtime.status).toBe("connected");

    const tools = await app.request("/v1/mcp/servers/echo/tools");
    expect(tools.status).toBe(200);
    expect((await tools.json()).items).toEqual([{ name: "echo", description: "Echo input", enabled: true }]);
    cleanup();
  });
});
