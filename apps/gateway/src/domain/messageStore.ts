import type { DB } from "../persistence/sqlite";
import type {
  Message,
  MessageId,
  MessageRole,
  ConversationId,
  RunId,
} from "@vulture/protocol/src/v1/conversation";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { brandId } from "@vulture/common";

interface Row {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  run_id: string | null;
  created_at: string;
}

function rowToMessage(r: Row): Message {
  return {
    id: r.id as MessageId,
    conversationId: r.conversation_id as ConversationId,
    role: r.role as MessageRole,
    content: r.content,
    runId: (r.run_id ?? null) as RunId | null,
    createdAt: r.created_at as Iso8601,
  };
}

function genId(): MessageId {
  return brandId<MessageId>(`m-${crypto.randomUUID()}`);
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  runId: string | null;
}

export class MessageStore {
  constructor(private readonly db: DB) {}

  append(input: AppendMessageInput): Message {
    const id = genId();
    const now = nowIso8601();
    this.db
      .query(
        "INSERT INTO messages(id, conversation_id, role, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.conversationId, input.role, input.content, input.runId, now);
    return this.get(id) as Message;
  }

  get(id: string): Message | null {
    const row = this.db
      .query("SELECT * FROM messages WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  listSince(opts: { conversationId: string; afterMessageId?: string }): Message[] {
    if (opts.afterMessageId) {
      const rows = this.db
        .query(
          "SELECT * FROM messages WHERE conversation_id = ? AND rowid > (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid ASC",
        )
        .all(opts.conversationId, opts.afterMessageId) as Row[];
      return rows.map(rowToMessage);
    }
    const rows = this.db
      .query(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC",
      )
      .all(opts.conversationId) as Row[];
    return rows.map(rowToMessage);
  }
}
