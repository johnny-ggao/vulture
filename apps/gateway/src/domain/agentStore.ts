import { mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { brandId } from "@vulture/common";
import type { DB } from "../persistence/sqlite";
import type {
  Agent,
  AgentId,
  AgentToolName,
  ReasoningLevel,
  SaveAgentRequest,
} from "@vulture/protocol/src/v1/agent";
import type { Workspace, WorkspaceId } from "@vulture/protocol/src/v1/workspace";
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
  tools: ["shell.exec", "browser.snapshot", "browser.click"],
  instructions: [
    "You are Vulture's local work agent.",
    "Complete the user's task directly; do not reply with standby text like asking for another task.",
    "For workspace questions, inspect the repository structure before summarizing.",
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
    if (count > 0) return;
    this._save(DEFAULT_AGENT);
  }

  private _save(req: SaveAgentRequest): Agent {
    const now = nowIso8601();
    const existingRow = this.db.query("SELECT * FROM agents WHERE id = ?").get(req.id) as AgentRow | undefined;
    const existing = existingRow ? rowToAgent(existingRow) : undefined;
    const workspace = this.ensureAgentWorkspace(req.id, req.name, existing?.workspace as Workspace | undefined);
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
  ): Workspace {
    if (existing && existsSync(existing.path) && statSync(existing.path).isDirectory()) {
      return existing;
    }
    const path = join(this.profileDir, "agents", agentId, "workspace");
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
}
