import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { McpServerStore } from "./mcpServerStore";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-mcp-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const cwd = join(dir, "server");
  mkdirSync(cwd);
  return {
    dir,
    cwd,
    store: new McpServerStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

describe("McpServerStore", () => {
  test("creates and lists stdio server configs", () => {
    const { store, cwd, cleanup } = freshStore();

    const created = store.create({
      id: "echo",
      name: "Echo",
      transport: "stdio",
      command: "bun",
      args: ["run", "server.ts"],
      cwd,
      env: { EXAMPLE: "1" },
      trust: "ask",
      enabled: true,
    });

    expect(created.id).toBe("echo");
    expect(created.profileId).toBe("default");
    expect(created.args).toEqual(["run", "server.ts"]);
    expect(created.env).toEqual({ EXAMPLE: "1" });
    expect(created.enabled).toBe(true);
    expect(store.list()).toEqual([created]);
    cleanup();
  });

  test("updates trust and enabled state", () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "echo",
      name: "Echo",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: true,
    });

    const updated = store.update("echo", { trust: "trusted", enabled: false });

    expect(updated.trust).toBe("trusted");
    expect(updated.enabled).toBe(false);
    expect(store.get("echo")?.enabled).toBe(false);
    cleanup();
  });

  test("persists enabled and disabled MCP tool policy", () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "echo",
      name: "Echo",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: true,
      enabledTools: ["read_text_file", "list_directory"],
      disabledTools: ["write_file"],
    });

    expect(store.get("echo")).toMatchObject({
      enabledTools: ["read_text_file", "list_directory"],
      disabledTools: ["write_file"],
    });

    const updated = store.update("echo", {
      enabledTools: null,
      disabledTools: ["delete_file"],
    });

    expect(updated.enabledTools).toBeNull();
    expect(updated.disabledTools).toEqual(["delete_file"]);
    cleanup();
  });

  test("deletes a config", () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "echo",
      name: "Echo",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: true,
    });

    store.delete("echo");

    expect(store.get("echo")).toBeNull();
    expect(store.list()).toEqual([]);
    cleanup();
  });

  test("filters loadable servers", () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "enabled",
      name: "Enabled",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: true,
    });
    store.create({
      id: "off",
      name: "Off",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: false,
    });
    store.create({
      id: "disabled",
      name: "Disabled",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "disabled",
      enabled: true,
    });

    expect(store.listLoadable().map((server) => server.id)).toEqual(["enabled"]);
    cleanup();
  });

  test("rejects invalid config", () => {
    const { store, cleanup } = freshStore();

    expect(() =>
      store.create({
        id: "bad",
        name: "Bad",
        transport: "stdio",
        command: "",
        args: [],
        cwd: null,
        env: {},
        trust: "ask",
        enabled: true,
      }),
    ).toThrow("command is required");
    expect(() =>
      store.create({
        id: "bad-cwd",
        name: "Bad Cwd",
        transport: "stdio",
        command: "bun",
        args: [],
        cwd: "relative",
        env: {},
        trust: "ask",
        enabled: true,
      }),
    ).toThrow("cwd must be absolute");
    cleanup();
  });
});
