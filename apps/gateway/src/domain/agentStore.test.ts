import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandId } from "@vulture/common";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AgentStore, privateWorkspacePathForAgent } from "./agentStore";
import { AGENT_TOOL_NAMES, type AgentId } from "@vulture/protocol/src/v1/agent";

function freshStore(defaultWorkspace?: string) {
  const dir = mkdtempSync(join(tmpdir(), "vulture-agent-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return {
    store: new AgentStore(db, dir, defaultWorkspace, dir),
    dir,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true }); },
  };
}

describe("AgentStore", () => {
  test("ensures default agent on first list", () => {
    const { store, cleanup } = freshStore();
    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(brandId<AgentId>("local-work-agent"));
    expect(list[0].instructions.length).toBeGreaterThan(0);
    cleanup();
  });

  test("default agent gets a private workspace under ~/.vuture/workspace/<agent slug>", () => {
    const { store, dir, cleanup } = freshStore();
    const [agent] = store.list();
    expect(agent.workspace.id).toBe(brandId("local-work-agent-workspace"));
    expect(agent.workspace.path).toBe(join(dir, ".vuture", "workspace", "local-work-agent"));
    cleanup();
  });

  test("default agent uses configured default workspace when available", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-default-workspace-"));
    const { store, cleanup } = freshStore(root);
    const [agent] = store.list();
    expect(agent.workspace.path).toBe(root);
    expect(agent.workspace.id).toBe(brandId("local-work-agent-workspace"));
    cleanup();
    rmSync(root, { recursive: true });
  });

  test("empty private default workspace is backfilled to configured default workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-default-workspace-"));
    const { store, dir, cleanup } = freshStore();
    const [before] = store.list();
    expect(before.workspace.path).toBe(join(dir, ".vuture", "workspace", "local-work-agent"));

    const db = openDatabase(join(dir, "data.sqlite"));
    const updatedStore = new AgentStore(db, dir, root, dir);
    const after = updatedStore.get("local-work-agent");
    expect(after?.workspace.path).toBe(root);
    db.close();
    cleanup();
    rmSync(root, { recursive: true });
  });

  test("old managed default workspace is replaced by the private agent-name path", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-default-workspace-"));
    writeFileSync(join(root, "repo-file.txt"), "do not move");
    const { store, dir, cleanup } = freshStore(root);
    const [before] = store.list();
    expect(before.workspace.path).toBe(root);

    const db = openDatabase(join(dir, "data.sqlite"));
    const updatedStore = new AgentStore(db, dir, undefined, dir);
    const after = updatedStore.get("local-work-agent");

    expect(after?.workspace.path).toBe(join(dir, ".vuture", "workspace", "local-work-agent"));
    expect(existsSync(join(after?.workspace.path ?? "", "repo-file.txt"))).toBe(false);
    expect(existsSync(join(root, "repo-file.txt"))).toBe(true);
    db.close();
    cleanup();
    rmSync(root, { recursive: true });
  });

  test("non-empty legacy private workspace is moved to the new agent-name path", () => {
    const { store, dir, cleanup } = freshStore();
    const [before] = store.list();
    const legacyPath = join(dir, "agents", "local-work-agent", "workspace");
    rmSync(before.workspace.path, { recursive: true, force: true });
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(join(legacyPath, "notes.txt"), "keep me");

    const db = openDatabase(join(dir, "data.sqlite"));
    db.query("UPDATE agents SET workspace_json = ? WHERE id = ?").run(
      JSON.stringify({ ...before.workspace, path: legacyPath }),
      "local-work-agent",
    );
    const updatedStore = new AgentStore(db, dir, undefined, dir);
    const after = updatedStore.get("local-work-agent");

    expect(after?.workspace.path).toBe(join(dir, ".vuture", "workspace", "local-work-agent"));
    expect(existsSync(join(after?.workspace.path ?? "", "notes.txt"))).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    db.close();
    cleanup();
  });

  test("old agent-name private workspace is moved to the slug path", () => {
    const { store, dir, cleanup } = freshStore();
    const [before] = store.list();
    const oldNamePath = join(dir, ".vuture", "workspace", "Local Work Agent");
    rmSync(before.workspace.path, { recursive: true, force: true });
    mkdirSync(oldNamePath, { recursive: true });
    writeFileSync(join(oldNamePath, "notes.txt"), "keep me");

    const db = openDatabase(join(dir, "data.sqlite"));
    db.query("UPDATE agents SET workspace_json = ? WHERE id = ?").run(
      JSON.stringify({ ...before.workspace, path: oldNamePath }),
      "local-work-agent",
    );
    const updatedStore = new AgentStore(db, dir, undefined, dir);
    const after = updatedStore.get("local-work-agent");

    expect(after?.workspace.path).toBe(join(dir, ".vuture", "workspace", "local-work-agent"));
    expect(existsSync(join(after?.workspace.path ?? "", "notes.txt"))).toBe(true);
    expect(existsSync(oldNamePath)).toBe(false);
    db.close();
    cleanup();
  });

  test("non-default legacy private workspace is moved when agents are loaded", () => {
    const { store, dir, cleanup } = freshStore();
    const saved = store.save({
      id: "coder",
      name: "Coder",
      description: "Writes code",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["shell.exec"],
      instructions: "Be careful.",
    });
    const legacyPath = join(dir, "agents", "coder", "workspace");
    rmSync(saved.workspace.path, { recursive: true, force: true });
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(join(legacyPath, "task.txt"), "old agent data");

    const db = openDatabase(join(dir, "data.sqlite"));
    db.query("UPDATE agents SET workspace_json = ? WHERE id = ?").run(
      JSON.stringify({ ...saved.workspace, path: legacyPath }),
      "coder",
    );
    const updatedStore = new AgentStore(db, dir, undefined, dir);
    const after = updatedStore.get("coder");

    expect(after?.workspace.path).toBe(join(dir, ".vuture", "workspace", "coder"));
    expect(existsSync(join(after?.workspace.path ?? "", "task.txt"))).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    db.close();
    cleanup();
  });

  test("default agent exposes all built-in gateway tools", () => {
    const { store, cleanup } = freshStore();
    const [agent] = store.list();
    expect(agent.tools).toEqual([...AGENT_TOOL_NAMES]);
    expect(agent.skills).toBeUndefined();
    cleanup();
  });

  test("save creates new agent", () => {
    const { store, dir, cleanup } = freshStore();
    const saved = store.save({
      id: "coder",
      name: "Coder",
      description: "Writes code",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["shell.exec"],
      instructions: "Be careful.",
    });
    expect(saved.id).toBe(brandId<AgentId>("coder"));
    expect(saved.workspace.path).toBe(join(dir, ".vuture", "workspace", "coder"));
    const ids = store.list().map((a) => a.id).sort((a, b) => (a < b ? -1 : 1));
    const expected = [brandId<AgentId>("coder"), brandId<AgentId>("local-work-agent")].sort((a, b) => (a < b ? -1 : 1));
    expect(ids).toEqual(expected);
    cleanup();
  });

  test("private workspace directory names are derived safely from the agent name", () => {
    expect(privateWorkspacePathForAgent("/tmp/home", "agent-id", "Ops/Agent: 1")).toBe(
      join("/tmp/home", ".vuture", "workspace", "ops-agent-1"),
    );
    expect(privateWorkspacePathForAgent("/tmp/home", "fallback-id", " ../ ")).toBe(
      join("/tmp/home", ".vuture", "workspace", "fallback-id"),
    );
  });

  test("save preserves requested workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "vulture-agent-workspace-"));
    const { store, cleanup } = freshStore();
    const saved = store.save({
      id: "coder",
      name: "Coder",
      description: "Writes code",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["read"],
      workspace: {
        id: "repo",
        name: "Repo",
        path: workspace,
      },
      instructions: "Be careful.",
    });
    expect(saved.workspace.path).toBe(workspace);
    expect(saved.workspace.id).toBe(brandId("repo"));
    cleanup();
    rmSync(workspace, { recursive: true });
  });

  test("save persists explicit skills allowlist", () => {
    const { store, cleanup } = freshStore();
    const saved = store.save({
      id: "coder",
      name: "Coder",
      description: "Writes code",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["read"],
      skills: ["csv-insights"],
      instructions: "Be careful.",
    });
    expect(saved.skills).toEqual(["csv-insights"]);
    expect(store.get("coder")?.skills).toEqual(["csv-insights"]);
    cleanup();
  });

  test("save persists empty skills allowlist as disabled", () => {
    const { store, cleanup } = freshStore();
    const saved = store.save({
      id: "coder",
      name: "Coder",
      description: "Writes code",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["read"],
      skills: [],
      instructions: "Be careful.",
    });
    expect(saved.skills).toEqual([]);
    expect(store.get("coder")?.skills).toEqual([]);
    cleanup();
  });

  test("delete refuses last agent", () => {
    const { store, cleanup } = freshStore();
    store.list();
    expect(() => store.delete("local-work-agent")).toThrow(/last/i);
    cleanup();
  });

  test("delete removes non-last agent", () => {
    const { store, cleanup } = freshStore();
    store.save({
      id: "coder",
      name: "Coder",
      description: "x",
      model: "gpt-5.4",
      reasoning: "low",
      tools: [],
      instructions: "x",
    });
    store.delete("local-work-agent");
    const ids = store.list().map((a) => a.id);
    expect(ids).toEqual([brandId<AgentId>("coder")]);
    cleanup();
  });

  test("get returns null for unknown id", () => {
    const { store, cleanup } = freshStore();
    expect(store.get("nope")).toBeNull();
    cleanup();
  });
});
