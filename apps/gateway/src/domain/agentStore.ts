import { mkdirSync, existsSync, statSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { brandId } from "@vulture/common";
import type { DB } from "../persistence/sqlite";
import type {
  Agent,
  AgentId,
  AgentToolName,
  ReasoningLevel,
  SaveAgentRequest,
} from "@vulture/protocol/src/v1/agent";
import { AGENT_TOOL_NAMES } from "@vulture/protocol/src/v1/agent";
import type {
  SaveWorkspaceRequest,
  Workspace,
  WorkspaceId,
} from "@vulture/protocol/src/v1/workspace";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";

interface AgentRow {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: string;
  tools: string;
  skills?: string | null;
  workspace_json: string;
  instructions: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_AGENT: SaveAgentRequest = {
  id: "local-work-agent",
  name: "Local Work Agent",
  description: "General local work assistant",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: [...AGENT_TOOL_NAMES],
  instructions: [
    "You are Vulture's local work agent.",
    "Complete the user's task directly; do not reply with standby text like asking for another task.",
    "For workspace questions, inspect the repository structure before summarizing.",
    "For direct file reads, use the read tool before considering shell commands.",
    "Request local actions through tools and never claim a local command ran unless a tool result confirms it.",
    "Answer in concise Chinese when the user writes Chinese.",
  ].join(" "),
};

function rowToAgent(r: AgentRow): Agent {
  const workspace_data = JSON.parse(r.workspace_json);
  return {
    id: brandId<AgentId>(r.id),
    name: r.name,
    description: r.description,
    model: r.model,
    reasoning: r.reasoning as ReasoningLevel,
    tools: JSON.parse(r.tools) as AgentToolName[],
    skills: parseSkillsJson(r.skills),
    workspace: {
      id: brandId<WorkspaceId>(workspace_data.id),
      name: workspace_data.name,
      path: workspace_data.path,
      createdAt: workspace_data.createdAt as Iso8601,
      updatedAt: workspace_data.updatedAt as Iso8601,
    } as Workspace,
    instructions: r.instructions,
    createdAt: r.created_at as Iso8601,
    updatedAt: r.updated_at as Iso8601,
  };
}

export class AgentStore {
  constructor(
    private readonly db: DB,
    private readonly profileDir: string,
    private readonly defaultWorkspacePath?: string,
    private readonly privateWorkspaceHomeDir: string = homedir(),
  ) {}

  list(): Agent[] {
    this.ensureDefault();
    const rows = this.db.query("SELECT * FROM agents ORDER BY name ASC").all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  get(id: string): Agent | null {
    this.ensureDefault();
    const row = this.db.query("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  save(req: SaveAgentRequest): Agent {
    this.ensureDefault();
    return this._save(req);
  }

  delete(id: string): void {
    this.ensureDefault();
    const remaining = (
      this.db.query("SELECT COUNT(*) AS c FROM agents").get() as { c: number }
    ).c;
    if (remaining <= 1) {
      throw new Error("cannot delete the last agent");
    }
    this.db.query("DELETE FROM agents WHERE id = ?").run(id);
  }

  private ensureDefault(): void {
    const count = (this.db.query("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
    if (count > 0) {
      this.ensureDefaultToolsCurrent();
      this.ensureLegacyPrivateWorkspacesCurrent();
      this.ensureDefaultWorkspaceCurrent();
      return;
    }
    this._save(DEFAULT_AGENT);
  }

  private ensureDefaultToolsCurrent(): void {
    const existingRow = this.db
      .query("SELECT * FROM agents WHERE id = ?")
      .get(DEFAULT_AGENT.id) as AgentRow | undefined;
    if (!existingRow) return;
    const existingTools = JSON.parse(existingRow.tools) as string[];
    const merged = [...new Set([...existingTools, ...AGENT_TOOL_NAMES])];
    if (merged.length === existingTools.length) return;
    this.db
      .query("UPDATE agents SET tools = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), nowIso8601(), DEFAULT_AGENT.id);
  }

  private ensureLegacyPrivateWorkspacesCurrent(): void {
    const rows = this.db.query("SELECT * FROM agents").all() as AgentRow[];
    for (const row of rows) {
      const agent = rowToAgent(row);
      const workspace = agent.workspace as Workspace;
      if (
        !this.isLegacyPrivateWorkspace(row.id, workspace.path) &&
        !this.isOutdatedManagedPrivateWorkspace(row.id, row.name, workspace)
      ) {
        continue;
      }
      const migrated = this.migrateLegacyPrivateWorkspace(row.id, row.name, workspace);
      if (migrated.path === workspace.path) continue;
      this.db
        .query("UPDATE agents SET workspace_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(migrated), nowIso8601(), row.id);
    }
  }

  private _save(req: SaveAgentRequest): Agent {
    const now = nowIso8601();
    const existingRow = this.db.query("SELECT * FROM agents WHERE id = ?").get(req.id) as AgentRow | undefined;
    const existing = existingRow ? rowToAgent(existingRow) : undefined;
    const workspace = this.ensureAgentWorkspace(
      req.id,
      req.name,
      existing?.workspace as Workspace | undefined,
      req.workspace,
    );
    if (existing) {
      this.db
        .query(
          "UPDATE agents SET name=?, description=?, model=?, reasoning=?, tools=?, skills=?, workspace_json=?, instructions=?, updated_at=? WHERE id=?",
        )
        .run(
          req.name,
          req.description,
          req.model,
          req.reasoning,
          JSON.stringify(req.tools),
          req.skills === undefined ? null : JSON.stringify(req.skills),
          JSON.stringify(workspace),
          req.instructions,
          now,
          req.id,
        );
    } else {
      this.db
        .query(
          `INSERT INTO agents(id, name, description, model, reasoning, tools, skills, workspace_json, instructions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          req.id,
          req.name,
          req.description,
          req.model,
          req.reasoning,
          JSON.stringify(req.tools),
          req.skills === undefined ? null : JSON.stringify(req.skills),
          JSON.stringify(workspace),
          req.instructions,
          now,
          now,
        );
    }
    const savedRow = this.db.query("SELECT * FROM agents WHERE id = ?").get(req.id) as AgentRow;
    return rowToAgent(savedRow);
  }

  private ensureAgentWorkspace(
    agentId: string,
    agentName: string,
    existing?: Workspace,
    requested?: SaveWorkspaceRequest,
  ): Workspace {
    if (requested) {
      return this.workspaceFromRequest(requested, existing);
    }
    if (existing && this.isLegacyPrivateWorkspace(agentId, existing.path)) {
      return this.migrateLegacyPrivateWorkspace(agentId, agentName, existing);
    }
    if (existing && existsSync(existing.path) && statSync(existing.path).isDirectory()) {
      return existing;
    }
    const defaultWorkspace = this.defaultWorkspaceFor(agentId);
    if (defaultWorkspace) {
      return defaultWorkspace;
    }
    return this.createPrivateWorkspace(agentId, agentName, existing);
  }

  private migrateLegacyPrivateWorkspace(
    agentId: string,
    agentName: string,
    existing: Workspace,
  ): Workspace {
    const desiredPath = this.privateWorkspacePath(agentId, agentName);
    if (existing.path === desiredPath) return existing;

    if (existsSync(existing.path) && statSync(existing.path).isDirectory()) {
      mkdirSync(dirname(desiredPath), { recursive: true });
      if (existsSync(desiredPath)) {
        if (!statSync(desiredPath).isDirectory()) {
          throw new Error(`private workspace path is not a directory: ${desiredPath}`);
        }
        if (readdirSync(desiredPath).length === 0) {
          rmSync(desiredPath, { recursive: true, force: true });
          renameSync(existing.path, desiredPath);
        } else {
          this.mergeWorkspaceDirectories(existing.path, desiredPath);
        }
      } else {
        renameSync(existing.path, desiredPath);
      }
    } else {
      mkdirSync(desiredPath, { recursive: true });
    }

    return {
      ...existing,
      path: desiredPath,
      updatedAt: nowIso8601(),
    };
  }

  private mergeWorkspaceDirectories(sourcePath: string, targetPath: string): void {
    for (const entry of readdirSync(sourcePath)) {
      const from = join(sourcePath, entry);
      let to = join(targetPath, entry);
      if (existsSync(to)) {
        const parsed = parse(entry);
        to = join(targetPath, `${parsed.name}.legacy-${Date.now()}${parsed.ext}`);
      }
      renameSync(from, to);
    }
    rmSync(sourcePath, { recursive: true, force: true });
  }

  private createPrivateWorkspace(
    agentId: string,
    agentName: string,
    existing?: Workspace,
  ): Workspace {
    const path = this.privateWorkspacePath(agentId, agentName);
    mkdirSync(path, { recursive: true });
    const now = nowIso8601();
    return {
      id: existing?.id ?? brandId<WorkspaceId>(`${agentId}-workspace`),
      name: existing?.name ?? `${agentName} Workspace`,
      path,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private ensureDefaultWorkspaceCurrent(): void {
    const existingRow = this.db
      .query("SELECT * FROM agents WHERE id = ?")
      .get(DEFAULT_AGENT.id) as AgentRow | undefined;
    if (!existingRow) return;
    const existing = rowToAgent(existingRow).workspace as Workspace;
    let desired = this.defaultWorkspaceFor(DEFAULT_AGENT.id, existing);
    let replacingManagedDefaultWorkspace = false;
    if (!desired) {
      if (this.isLegacyPrivateWorkspace(DEFAULT_AGENT.id, existing.path)) {
        desired = this.migrateLegacyPrivateWorkspace(DEFAULT_AGENT.id, DEFAULT_AGENT.name, existing);
      } else if (this.isManagedPrivateWorkspace(DEFAULT_AGENT.id, existing)) {
        desired = this.createPrivateWorkspace(DEFAULT_AGENT.id, DEFAULT_AGENT.name, existing);
        replacingManagedDefaultWorkspace = true;
      } else {
        return;
      }
    }
    if (existing.path === desired.path) return;
    if (
      !replacingManagedDefaultWorkspace &&
      !this.isEmptyPrivateWorkspace(DEFAULT_AGENT.id, DEFAULT_AGENT.name, existing.path)
    ) {
      return;
    }
    this.db
      .query("UPDATE agents SET workspace_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(desired), nowIso8601(), DEFAULT_AGENT.id);
  }

  private workspaceFromRequest(
    requested: SaveWorkspaceRequest,
    existing?: Workspace,
  ): Workspace {
    if (!existsSync(requested.path) || !statSync(requested.path).isDirectory()) {
      throw new Error(`workspace path is not a directory: ${requested.path}`);
    }
    const now = nowIso8601();
    return {
      id: brandId<WorkspaceId>(requested.id),
      name: requested.name,
      path: requested.path,
      createdAt: existing?.id === requested.id ? existing.createdAt : now,
      updatedAt: now,
    };
  }

  private defaultWorkspaceFor(agentId: string, existing?: Workspace): Workspace | null {
    if (agentId !== DEFAULT_AGENT.id) return null;
    const path = this.defaultWorkspacePath;
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) return null;
    const now = nowIso8601();
    return {
      id: existing?.id ?? brandId<WorkspaceId>(`${agentId}-workspace`),
      name: existing?.name ?? `${basename(path)} Workspace`,
      path,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private privateWorkspacePath(agentId: string, agentName: string): string {
    return privateWorkspacePathForAgent(this.privateWorkspaceHomeDir, agentId, agentName);
  }

  private privateWorkspaceRoot(): string {
    return join(this.privateWorkspaceHomeDir, ".vuture", "workspace");
  }

  private legacyPrivateWorkspacePath(agentId: string): string {
    return join(this.profileDir, "agents", agentId, "workspace");
  }

  private isLegacyPrivateWorkspace(agentId: string, path: string): boolean {
    return path === this.legacyPrivateWorkspacePath(agentId);
  }

  private isManagedPrivateWorkspace(agentId: string, workspace: Workspace): boolean {
    return workspace.id === brandId<WorkspaceId>(`${agentId}-workspace`);
  }

  private isOutdatedManagedPrivateWorkspace(
    agentId: string,
    agentName: string,
    workspace: Workspace,
  ): boolean {
    return (
      this.isManagedPrivateWorkspace(agentId, workspace) &&
      dirname(workspace.path) === this.privateWorkspaceRoot() &&
      workspace.path !== this.privateWorkspacePath(agentId, agentName)
    );
  }

  private isEmptyPrivateWorkspace(agentId: string, agentName: string, path: string): boolean {
    if (
      path !== this.privateWorkspacePath(agentId, agentName) &&
      path !== this.legacyPrivateWorkspacePath(agentId)
    ) {
      return false;
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) return true;
    return readdirSync(path).length === 0;
  }

}

export function privateWorkspacePathForAgent(
  homeDir: string,
  agentId: string,
  agentName: string,
): string {
  return join(homeDir, ".vuture", "workspace", privateWorkspaceDirName(agentId, agentName));
}

function privateWorkspaceDirName(agentId: string, agentName: string): string {
  const normalized = agentName
    .trim()
    .toLowerCase()
    .replace(/[\\/:"*?<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+$/, "")
    .replace(/^\.\.+/, "")
    .trim();
  return normalized.length > 0 && /[\p{L}\p{N}]/u.test(normalized) ? normalized : agentId.toLowerCase();
}

function parseSkillsJson(raw: string | null | undefined): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : undefined;
  } catch {
    return undefined;
  }
}
