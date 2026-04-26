import { existsSync, statSync } from "node:fs";
import type { DB } from "../persistence/sqlite";
import type {
  Workspace,
  WorkspaceId,
  SaveWorkspaceRequest,
} from "@vulture/protocol/src/v1/workspace";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";

interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id as WorkspaceId,
    name: r.name,
    path: r.path,
    createdAt: r.created_at as Iso8601,
    updatedAt: r.updated_at as Iso8601,
  };
}

export class WorkspaceStore {
  constructor(private readonly db: DB) {}

  list(): Workspace[] {
    const rows = this.db
      .query(
        "SELECT id, name, path, created_at, updated_at FROM workspaces ORDER BY name ASC",
      )
      .all() as WorkspaceRow[];
    return rows.map(rowToWorkspace);
  }

  get(id: string): Workspace | null {
    const row = this.db
      .query(
        "SELECT id, name, path, created_at, updated_at FROM workspaces WHERE id = ?",
      )
      .get(id) as WorkspaceRow | undefined;
    return row ? rowToWorkspace(row) : null;
  }

  save(req: SaveWorkspaceRequest): Workspace {
    if (!existsSync(req.path) || !statSync(req.path).isDirectory()) {
      throw new Error(`workspace path is not a directory: ${req.path}`);
    }
    const now = nowIso8601();
    const existing = this.get(req.id);
    if (existing) {
      this.db
        .query(
          "UPDATE workspaces SET name = ?, path = ?, updated_at = ? WHERE id = ?",
        )
        .run(req.name, req.path, now, req.id);
    } else {
      this.db
        .query(
          "INSERT INTO workspaces(id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(req.id, req.name, req.path, now, now);
    }
    return this.get(req.id) as Workspace;
  }

  delete(id: string): void {
    this.db.query("DELETE FROM workspaces WHERE id = ?").run(id);
  }
}
