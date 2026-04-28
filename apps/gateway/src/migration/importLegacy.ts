import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DB } from "../persistence/sqlite";
import { privateWorkspacePathForAgent } from "../domain/agentStore";

export interface ImportResult {
  agentsImported: number;
  workspacesImported: number;
}

interface LegacyAgentJson {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: string;
  tools: string[];
  createdAt: string;
  updatedAt: string;
}

interface LegacyWorkspaceJson {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export function importLegacy(opts: {
  profileDir: string;
  db: DB;
  privateWorkspaceHomeDir?: string;
}): ImportResult {
  const result: ImportResult = { agentsImported: 0, workspacesImported: 0 };
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("Z", "");

  const agentsDir = join(opts.profileDir, "agents");
  if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
    for (const entry of readdirSync(agentsDir)) {
      const agentDir = join(agentsDir, entry);
      const jsonPath = join(agentDir, "agent.json");
      const instrPath = join(agentDir, "instructions.md");
      if (!existsSync(jsonPath)) continue;
      const json = JSON.parse(readFileSync(jsonPath, "utf8")) as LegacyAgentJson;
      const instructions = existsSync(instrPath)
        ? readFileSync(instrPath, "utf8")
        : "";
      const wsPath = privateWorkspacePathForAgent(
        opts.privateWorkspaceHomeDir ?? homedir(),
        json.id,
        json.name,
      );
      // Ensure the workspace directory exists on disk; otherwise shell.exec
      // will fail at spawn() with a misleading ENOENT.
      mkdirSync(wsPath, { recursive: true });
      const wsJson = JSON.stringify({
        id: `${json.id}-workspace`,
        name: `${json.name} Workspace`,
        path: wsPath,
        createdAt: json.createdAt,
        updatedAt: json.updatedAt,
      });
      opts.db
        .query(
          `INSERT OR REPLACE INTO agents(id, name, description, model, reasoning, tools, workspace_json, instructions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          json.id,
          json.name,
          json.description,
          json.model,
          json.reasoning,
          JSON.stringify(json.tools ?? []),
          wsJson,
          instructions,
          json.createdAt,
          json.updatedAt,
        );
      result.agentsImported += 1;
    }
    renameSync(agentsDir, join(opts.profileDir, `agents.bak.${ts}`));
  }

  const wsDir = join(opts.profileDir, "workspaces");
  if (existsSync(wsDir) && statSync(wsDir).isDirectory()) {
    for (const entry of readdirSync(wsDir)) {
      if (!entry.endsWith(".json")) continue;
      const path = join(wsDir, entry);
      const json = JSON.parse(
        readFileSync(path, "utf8"),
      ) as LegacyWorkspaceJson;
      opts.db
        .query(
          `INSERT OR REPLACE INTO workspaces(id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(json.id, json.name, json.path, json.createdAt, json.updatedAt);
      result.workspacesImported += 1;
    }
    renameSync(wsDir, join(opts.profileDir, `workspaces.bak.${ts}`));
  }

  return result;
}
