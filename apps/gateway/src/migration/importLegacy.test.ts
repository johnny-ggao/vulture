import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { importLegacy } from "./importLegacy";
import { AgentStore } from "../domain/agentStore";
import { WorkspaceStore } from "../domain/workspaceStore";

function seedLegacy(dir: string) {
  const agentDir = join(dir, "agents", "old-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "agent.json"),
    JSON.stringify({
      id: "old-agent",
      name: "Old Agent",
      description: "from disk",
      model: "gpt-5.4",
      reasoning: "low",
      tools: ["shell.exec"],
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    }),
  );
  writeFileSync(join(agentDir, "instructions.md"), "Be careful out there.");

  const wsDir = join(dir, "workspaces");
  mkdirSync(wsDir, { recursive: true });
  const realWs = join(dir, "real-ws");
  mkdirSync(realWs);
  writeFileSync(
    join(wsDir, "ws-1.json"),
    JSON.stringify({
      id: "ws-1",
      name: "WS 1",
      path: realWs,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    }),
  );
}

describe("importLegacy", () => {
  test("imports agents + workspaces + renames originals to .bak.<ts>", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-import-"));
    seedLegacy(dir);
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);

    const result = importLegacy({ profileDir: dir, db, privateWorkspaceHomeDir: dir });
    expect(result.agentsImported).toBe(1);
    expect(result.workspacesImported).toBe(1);

    const agents = new AgentStore(db, dir, undefined, dir).list();
    const importedAgent = agents.find((a) => a.id === "old-agent");
    expect(importedAgent).toBeTruthy();
    expect(importedAgent?.workspace.path).toBe(join(dir, ".vuture", "workspace", "old-agent", "project"));
    expect(existsSync(join(dir, ".vuture", "workspace", "old-agent", "agent-core", "AGENTS.md"))).toBe(true);
    const ws = new WorkspaceStore(db).list();
    expect(ws.find((w) => w.id === "ws-1")).toBeTruthy();

    const dirs = readdirSync(dir);
    expect(dirs.some((d) => d.startsWith("agents.bak."))).toBe(true);
    expect(dirs.some((d) => d.startsWith("workspaces.bak."))).toBe(true);
    expect(existsSync(join(dir, "agents"))).toBe(false);
    expect(existsSync(join(dir, "workspaces"))).toBe(false);

    db.close();
    rmSync(dir, { recursive: true });
  });

  test("idempotent: no legacy dirs → 0/0 imported", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-import-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);

    const r1 = importLegacy({ profileDir: dir, db });
    expect(r1.agentsImported).toBe(0);
    expect(r1.workspacesImported).toBe(0);

    db.close();
    rmSync(dir, { recursive: true });
  });
});
