import { mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
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
          "UPDATE agents SET name=?, description=?, model=?, reasoning=?, tools=?, workspace_json=?, instructions=?, updated_at=? WHERE id=?",
        )
        .run(
          req.name,
          req.description,
          req.model,
          req.reasoning,
          JSON.stringify(req.tools),
          JSON.stringify(workspace),
          req.instructions,
          now,
          req.id,
        );
    } else {
      this.db
        .query(
          `INSERT INTO agents(id, name, description, model, reasoning, tools, workspace_json, instructions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          req.id,
          req.name,
          req.description,
          req.model,
          req.reasoning,
          JSON.stringify(req.tools),
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
    if (existing && existsSync(existing.path) && statSync(existing.path).isDirectory()) {
      return existing;
    }
    const defaultWorkspace = this.defaultWorkspaceFor(agentId);
    if (defaultWorkspace) {
      return defaultWorkspace;
    }
    const path = this.privateWorkspacePath(agentId);
    mkdirSync(path, { recursive: true });
    const now = nowIso8601();
    return {
      id: brandId<WorkspaceId>(`${agentId}-workspace`),
      name: `${agentName} Workspace`,
      path,
      createdAt: now,
      updatedAt: now,
    };
  }

  private ensureDefaultWorkspaceCurrent(): void {
    const existingRow = this.db
      .query("SELECT * FROM agents WHERE id = ?")
      .get(DEFAULT_AGENT.id) as AgentRow | undefined;
    if (!existingRow) return;
    const existing = rowToAgent(existingRow).workspace as Workspace;
    const desired = this.defaultWorkspaceFor(DEFAULT_AGENT.id, existing);
    if (!desired || existing.path === desired.path) return;
    if (!this.isEmptyPrivateWorkspace(DEFAULT_AGENT.id, existing.path)) return;
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

  private privateWorkspacePath(agentId: string): string {
    return join(this.profileDir, "agents", agentId, "workspace");
  }

  private isEmptyPrivateWorkspace(agentId: string, path: string): boolean {
    if (path !== this.privateWorkspacePath(agentId)) return false;
    if (!existsSync(path) || !statSync(path).isDirectory()) return true;
    return readdirSync(path).length === 0;
  }
}
