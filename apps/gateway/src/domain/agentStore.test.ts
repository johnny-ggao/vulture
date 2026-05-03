import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    db,
    dir,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true }); },
  };
}

describe("AgentStore", () => {
  test("ensures both preset agents on first list", () => {
    const { store, cleanup } = freshStore();
    const list = store.list();
    expect(list.length).toBe(2);
    const ids = list.map((a) => a.id);
    expect(ids).toContain(brandId<AgentId>("local-work-agent"));
    expect(ids).toContain(brandId<AgentId>("coding-agent"));
    expect(list.find((a) => a.id === "local-work-agent")?.instructions.length).toBeGreaterThan(0);
    cleanup();
  });

  test("Vulture (general) gets an Accio-style private layout under ~/.vuture/workspace/<agent slug>", () => {
    const { store, dir, cleanup } = freshStore();
    const agent = store.get("local-work-agent")!;
    expect(agent.workspace.id).toBe(brandId("local-work-agent-workspace"));
    expect(agent.workspace.path).toBe(join(dir, ".vuture", "workspace", "vulture", "project"));
    expect(store.agentRootPath(agent.id)).toBe(join(dir, ".vuture", "workspace", "vulture"));
    expect(store.agentCorePath(agent.id)).toBe(join(dir, ".vuture", "workspace", "vulture", "agent-core"));
    for (const name of ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md"]) {
      expect(existsSync(join(store.agentCorePath(agent.id), name))).toBe(true);
    }
    expect(existsSync(join(store.agentCorePath(agent.id), "tool-registry.jsonc"))).toBe(true);
    expect(existsSync(join(store.agentCorePath(agent.id), "skills", "skills.jsonc"))).toBe(true);
    cleanup();
  });

  test("default agent uses configured default workspace when available", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-default-workspace-"));
    const { store, cleanup } = freshStore(root);
    const agent = store.get("local-work-agent")!;
    expect(agent.workspace.path).toBe(root);
    expect(agent.workspace.id).toBe(brandId("local-work-agent-workspace"));
    cleanup();
    rmSync(root, { recursive: true });
  });

  test("empty private default workspace is backfilled to configured default workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-default-workspace-"));
    const { store, dir, cleanup } = freshStore();
    const before = store.get("local-work-agent")!;
    expect(before.workspace.path).toBe(join(dir, ".vuture", "workspace", "vulture", "project"));

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
    const before = store.get("local-work-agent")!;
    expect(before.workspace.path).toBe(root);

    const db = openDatabase(join(dir, "data.sqlite"));
    const updatedStore = new AgentStore(db, dir, undefined, dir);
    const after = updatedStore.get("local-work-agent");

    expect(after?.workspace.path).toBe(join(dir, ".vuture", "workspace", "vulture", "project"));
    expect(existsSync(join(after?.workspace.path ?? "", "repo-file.txt"))).toBe(false);
    expect(existsSync(join(root, "repo-file.txt"))).toBe(true);
    db.close();
    cleanup();
    rmSync(root, { recursive: true });
  });

  test("non-empty legacy private workspace is moved to the new agent-name path", () => {
    const { store, dir, cleanup } = freshStore();
    const before = store.get("local-work-agent")!;
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

    expect(after?.workspace.path).toBe(join(dir, ".vuture", "workspace", "vulture", "project"));
    expect(existsSync(join(after?.workspace.path ?? "", "notes.txt"))).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    db.close();
    cleanup();
  });

  test("old agent-name private workspace is moved to the slug path", () => {
    const { store, dir, cleanup } = freshStore();
    const before = store.get("local-work-agent")!;
    // Simulate an outdated path that used the old name slug
    const oldNamePath = join(dir, ".vuture", "workspace", "local-work-agent");
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

    expect(after?.workspace.path).toBe(join(dir, ".vuture", "workspace", "vulture", "project"));
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

    expect(after?.workspace.path).toBe(join(dir, ".vuture", "workspace", "coder", "project"));
    expect(existsSync(join(after?.workspace.path ?? "", "task.txt"))).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    db.close();
    cleanup();
  });

  test("default agent exposes all built-in gateway tools", () => {
    const { store, cleanup } = freshStore();
    const [agent] = store.list();
    expect(agent.tools).toEqual([...AGENT_TOOL_NAMES]);
    expect(agent.toolPreset).toBe("full");
    expect(agent.toolInclude).toEqual([]);
    expect(agent.toolExclude).toEqual([]);
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
    expect(saved.description).toBe("Writes code");
    expect(saved.model).toBe("gpt-5.4");
    expect(saved.reasoning).toBe("medium");
    expect(saved.workspace.path).toBe(join(dir, ".vuture", "workspace", "coder", "project"));
    const ids = store.list().map((a) => a.id).sort((a, b) => (a < b ? -1 : 1));
    const expected = [
      brandId<AgentId>("coder"),
      brandId<AgentId>("coding-agent"),
      brandId<AgentId>("local-work-agent"),
    ].sort((a, b) => (a < b ? -1 : 1));
    expect(ids).toEqual(expected);
    cleanup();
  });

  test("save persists handoff agent ids", () => {
    const { store, cleanup } = freshStore();
    store.save({
      id: "researcher",
      name: "Researcher",
      description: "Finds facts",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["read"],
      instructions: "Research carefully.",
    });
    const saved = store.save({
      id: "lead",
      name: "Lead",
      description: "Delegates work",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: ["sessions_spawn", "sessions_yield", "sessions_history"],
      handoffAgentIds: ["researcher"],
      instructions: "Delegate when useful.",
    });

    expect(saved.handoffAgentIds).toEqual(["researcher"]);
    expect(store.get("lead")?.handoffAgentIds).toEqual(["researcher"]);
    cleanup();
  });

  test("save expands tool preset policy and writes tool registry", () => {
    const { store, cleanup } = freshStore();
    const saved = store.save({
      id: "coder",
      name: "Coder",
      description: "Writes code",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: [],
      toolPreset: "developer",
      toolInclude: [],
      toolExclude: ["browser.click"],
      instructions: "Be careful.",
    });
    expect(saved.toolPreset).toBe("developer");
    expect(saved.toolInclude).toEqual([]);
    expect(saved.toolExclude).toEqual(["browser.click"]);
    expect(saved.tools).toContain("shell.exec");
    expect(saved.tools).toContain("apply_patch");
    expect(saved.tools).not.toContain("browser.click");

    const registry = readFileSync(join(store.agentCorePath(saved.id), "tool-registry.jsonc"), "utf8");
    expect(registry).toContain('"preset": "developer"');
    expect(registry).toContain('"exclude": [');
    expect(registry).toContain('"browser.click"');
    cleanup();
  });

  test("stored preset agents expand to newly added preset tools", () => {
    const { store, db, cleanup } = freshStore();
    const saved = store.save({
      id: "coder",
      name: "Coder",
      description: "Writes code",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: [],
      toolPreset: "developer",
      toolInclude: [],
      toolExclude: ["browser.click"],
      instructions: "Be careful.",
    });
    db.query("UPDATE agents SET tools = ? WHERE id = ?").run(
      JSON.stringify(["read", "write", "edit", "apply_patch", "shell.exec", "process", "web_search", "web_fetch"]),
      saved.id,
    );

    const reloaded = store.get("coder");

    expect(reloaded?.toolPreset).toBe("developer");
    expect(reloaded?.tools).toContain("web_extract");
    expect(reloaded?.tools).toContain("browser.input");
    expect(reloaded?.tools).toContain("browser.scroll");
    expect(reloaded?.tools).toContain("browser.extract");
    expect(reloaded?.tools).not.toContain("browser.click");
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
    expect(existsSync(join(workspace, "agent-core", "AGENTS.md"))).toBe(true);
    cleanup();
    rmSync(workspace, { recursive: true });
  });

  test("requested workspace named project is not treated as managed private root", () => {
    const parent = mkdtempSync(join(tmpdir(), "vulture-agent-workspace-parent-"));
    const workspace = join(parent, "project");
    mkdirSync(workspace);
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
    expect(store.agentRootPath(saved.id)).toBe(workspace);
    expect(store.agentCorePath(saved.id)).toBe(join(workspace, "agent-core"));
    cleanup();
    rmSync(parent, { recursive: true });
  });

  test("agent core files can be listed, read, and written through the store", () => {
    const { store, cleanup } = freshStore();
    const agent = store.get("local-work-agent")!;
    const files = store.listAgentCoreFiles(agent.id);
    expect(files.map((file) => file.name)).toContain("SOUL.md");
    const soul = store.readAgentCoreFile(agent.id, "SOUL.md");
    expect(soul.content).toContain("Vulture");

    const updated = store.writeAgentCoreFile(agent.id, "TOOLS.md", "# Tool notes\n");
    expect(updated.content).toBe("# Tool notes\n");
    expect(readFileSync(join(store.agentCorePath(agent.id), "TOOLS.md"), "utf8")).toBe("# Tool notes\n");
    cleanup();
  });

  test("agent core file access rejects unsupported names", () => {
    const { store, cleanup } = freshStore();
    const agent = store.get("local-work-agent")!;
    expect(() => store.readAgentCoreFile(agent.id, "../secrets")).toThrow(/unsupported/i);
    expect(() => store.writeAgentCoreFile(agent.id, "profile.jsonc", "{}")).toThrow(/unsupported/i);
    cleanup();
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

  test("deleting a preset re-seeds it via ensureDefaults (decision #7)", () => {
    const { store, cleanup } = freshStore();
    store.list(); // seed both
    store.delete("coding-agent");
    const ids = new Set(store.list().map((a) => String(a.id)));
    expect(ids.has("coding-agent")).toBe(true);
    expect(ids.has("local-work-agent")).toBe(true);
    cleanup();
  });

  test("delete removes a user-created agent (non-preset remains)", () => {
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
    store.delete("coder");
    const ids = store.list().map((a) => a.id);
    expect(ids).not.toContain(brandId<AgentId>("coder"));
    // Both presets still exist (re-seeded)
    expect(ids).toContain(brandId<AgentId>("local-work-agent"));
    expect(ids).toContain(brandId<AgentId>("coding-agent"));
    cleanup();
  });

  test("get returns null for unknown id", () => {
    const { store, cleanup } = freshStore();
    expect(store.get("nope")).toBeNull();
    cleanup();
  });
});

describe("preset agents seed", () => {
  test("first list seeds both Vulture and Vulture Coding", () => {
    const { store, cleanup } = freshStore();
    const agents = store.list();
    const ids = new Set(agents.map((a) => a.id));
    expect(ids.has("local-work-agent" as AgentId)).toBe(true);
    expect(ids.has("coding-agent" as AgentId)).toBe(true);
    const general = agents.find((a) => a.id === "local-work-agent")!;
    const coding = agents.find((a) => a.id === "coding-agent")!;
    expect(general.name).toBe("Vulture");
    expect(coding.name).toBe("Vulture Coding");
    expect(general.reasoning).toBe("medium");
    expect(coding.reasoning).toBe("high");
    expect(general.avatar).toBe("compass");
    expect(coding.avatar).toBe("circuit");
    cleanup();
  });

  test("ensureDefaults is idempotent — repeated list calls do not duplicate", () => {
    const { store, cleanup } = freshStore();
    store.list();
    store.list();
    store.list();
    const agents = store.list();
    expect(agents.filter((a) => a.id === "local-work-agent").length).toBe(1);
    expect(agents.filter((a) => a.id === "coding-agent").length).toBe(1);
    cleanup();
  });

  test("Vulture (general) USER.md contains '中文' and 'Default language'", () => {
    const { store, cleanup } = freshStore();
    store.list();
    const userMd = store.readAgentCoreFile("local-work-agent", "USER.md");
    expect(userMd.content).toContain("中文");
    expect(userMd.content).toContain("Default language");
    cleanup();
  });

  test("Vulture (general) IDENTITY.md does NOT contain 'test-driven'", () => {
    const { store, cleanup } = freshStore();
    store.list();
    const identityMd = store.readAgentCoreFile("local-work-agent", "IDENTITY.md");
    expect((identityMd.content ?? "").toLowerCase()).not.toContain("test-driven");
    cleanup();
  });

  test("Vulture Coding IDENTITY.md contains 'Vulture Coding', 'test-driven', and 'immutable'", () => {
    const { store, cleanup } = freshStore();
    store.list();
    const identityMd = store.readAgentCoreFile("coding-agent", "IDENTITY.md");
    expect(identityMd.content).toContain("Vulture Coding");
    expect((identityMd.content ?? "").toLowerCase()).toContain("test-driven");
    expect((identityMd.content ?? "").toLowerCase()).toContain("immutable");
    cleanup();
  });

  test("Vulture Coding IDENTITY.md is not overwritten by ensureDefaults when user override exists", () => {
    const { store, cleanup } = freshStore();
    store.list();
    store.writeAgentCoreFile("coding-agent", "IDENTITY.md", "# user override\n");
    store.list();
    const identityMd = store.readAgentCoreFile("coding-agent", "IDENTITY.md");
    expect(identityMd.content).toBe("# user override\n");
    cleanup();
  });

  test("Vulture Coding USER.md has identical content to Vulture USER.md", () => {
    const { store, cleanup } = freshStore();
    store.list();
    const generalUserMd = store.readAgentCoreFile("local-work-agent", "USER.md");
    const codingUserMd = store.readAgentCoreFile("coding-agent", "USER.md");
    expect(codingUserMd.content).toBe(generalUserMd.content);
    cleanup();
  });

});

describe("isUsingPrivateWorkspace", () => {
  test("returns true for freshly seeded coding-agent", () => {
    const { store, cleanup } = freshStore();
    store.list(); // seed both presets
    expect(store.isUsingPrivateWorkspace("coding-agent")).toBe(true);
    cleanup();
  });

  test("returns false after user changes workspace to a custom path", () => {
    const customWs = mkdtempSync(join(tmpdir(), "custom-ws-"));
    const { store, cleanup } = freshStore();
    const agent = store.get("coding-agent")!;
    store.save({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      model: agent.model,
      reasoning: agent.reasoning,
      tools: agent.tools,
      toolPreset: agent.toolPreset,
      toolInclude: agent.toolInclude,
      toolExclude: agent.toolExclude,
      instructions: agent.instructions,
      workspace: { id: "custom-ws", name: "Custom", path: customWs },
    });
    expect(store.isUsingPrivateWorkspace("coding-agent")).toBe(false);
    cleanup();
    rmSync(customWs, { recursive: true });
  });
});
