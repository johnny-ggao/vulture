import type { DB } from "../persistence/sqlite";
import type {
  Conversation,
  ConversationId,
  ConversationPermissionMode,
  CreateConversationRequest,
} from "@vulture/protocol/src/v1/conversation";
import type { AgentId } from "@vulture/protocol/src/v1/agent";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { brandId } from "@vulture/common";

interface Row {
  id: string;
  agent_id: string;
  title: string;
  permission_mode: string;
  working_directory: string | null;
  created_at: string;
  updated_at: string;
}

function rowToConversation(r: Row): Conversation {
  return {
    id: r.id as ConversationId,
    agentId: r.agent_id as AgentId,
    title: r.title,
    permissionMode: normalizePermissionMode(r.permission_mode),
    workingDirectory: r.working_directory ?? null,
    createdAt: r.created_at as Iso8601,
    updatedAt: r.updated_at as Iso8601,
  };
}

function normalizePermissionMode(value: string | null | undefined): ConversationPermissionMode {
  if (value === "full_access" || value === "read_only" || value === "auto_review") return value;
  return "default";
}

function genId(): ConversationId {
  return brandId<ConversationId>(`c-${crypto.randomUUID()}`);
}

export class ConversationStore {
  constructor(private readonly db: DB) {}

  create(req: CreateConversationRequest): Conversation {
    const now = nowIso8601();
    const id = genId();
    this.db
      .query(
        "INSERT INTO conversations(id, agent_id, title, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, req.agentId, req.title ?? "", req.permissionMode ?? "default", now, now);
    return this.get(id) as Conversation;
  }

  get(id: string): Conversation | null {
    const row = this.db
      .query("SELECT * FROM conversations WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? rowToConversation(row) : null;
  }

  list(filter: { agentId?: string } = {}): Conversation[] {
    const rows = filter.agentId
      ? (this.db
          .query("SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC")
          .all(filter.agentId) as Row[])
      : (this.db
          .query("SELECT * FROM conversations ORDER BY updated_at DESC")
          .all() as Row[]);
    return rows.map(rowToConversation);
  }

  delete(id: string): void {
    this.db.query("DELETE FROM conversations WHERE id = ?").run(id);
  }

  touch(id: string): void {
    this.db
      .query("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(nowIso8601(), id);
  }

  updateTitle(id: string, title: string): Conversation | null {
    this.db
      .query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, nowIso8601(), id);
    return this.get(id);
  }

  updatePermissionMode(
    id: string,
    permissionMode: ConversationPermissionMode,
  ): Conversation | null {
    this.db
      .query("UPDATE conversations SET permission_mode = ?, updated_at = ? WHERE id = ?")
      .run(permissionMode, nowIso8601(), id);
    return this.get(id);
  }

  /**
   * Set the per-conversation working directory override. Pass null to clear
   * it (the conversation will fall back to the agent's default workspace).
   * No path validation here — that's the route layer's job; the store
   * stores raw strings.
   */
  updateWorkingDirectory(id: string, workingDirectory: string | null): Conversation | null {
    this.db
      .query("UPDATE conversations SET working_directory = ?, updated_at = ? WHERE id = ?")
      .run(workingDirectory, nowIso8601(), id);
    return this.get(id);
  }
}
