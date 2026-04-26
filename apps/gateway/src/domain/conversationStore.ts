import type { DB } from "../persistence/sqlite";
import type {
  Conversation,
  ConversationId,
  CreateConversationRequest,
} from "@vulture/protocol/src/v1/conversation";
import type { AgentId } from "@vulture/protocol/src/v1/agent";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { brandId } from "@vulture/common";

interface Row {
  id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function rowToConversation(r: Row): Conversation {
  return {
    id: r.id as ConversationId,
    agentId: r.agent_id as AgentId,
    title: r.title,
    createdAt: r.created_at as Iso8601,
    updatedAt: r.updated_at as Iso8601,
  };
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
        "INSERT INTO conversations(id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, req.agentId, req.title ?? "", now, now);
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
}
