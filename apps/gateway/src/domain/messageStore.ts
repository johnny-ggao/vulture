import type { DB } from "../persistence/sqlite";
import type {
  Message,
  MessageAttachment,
  AttachmentKind,
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

interface AttachmentRow {
  message_id: string;
  id: string;
  blob_id: string;
  kind: string;
  display_name: string;
  created_at: string;
  mime_type: string;
  size_bytes: number;
}

function rowToMessage(r: Row, attachments: MessageAttachment[] = []): Message {
  return {
    id: r.id as MessageId,
    conversationId: r.conversation_id as ConversationId,
    role: r.role as MessageRole,
    content: r.content,
    runId: (r.run_id ?? null) as RunId | null,
    createdAt: r.created_at as Iso8601,
    attachments,
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
    return row ? rowToMessage(row, this.attachmentsForMessageIds([row.id]).get(row.id) ?? []) : null;
  }

  listSince(opts: { conversationId: string; afterMessageId?: string }): Message[] {
    let rows: Row[];
    if (opts.afterMessageId) {
      rows = this.db
        .query(
          "SELECT * FROM messages WHERE conversation_id = ? AND rowid > (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid ASC",
        )
        .all(opts.conversationId, opts.afterMessageId) as Row[];
    } else {
      rows = this.db
        .query(
          "SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC",
        )
        .all(opts.conversationId) as Row[];
    }
    const attachmentsByMessage = this.attachmentsForMessageIds(rows.map((row) => row.id));
    return rows.map((row) => rowToMessage(row, attachmentsByMessage.get(row.id) ?? []));
  }

  private attachmentsForMessageIds(messageIds: string[]): Map<string, MessageAttachment[]> {
    const result = new Map<string, MessageAttachment[]>();
    if (messageIds.length === 0) return result;
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT a.message_id, a.id, a.blob_id, a.kind, a.display_name, a.created_at,
                b.mime_type, b.size_bytes
         FROM message_attachments a
         JOIN blobs b ON b.id = a.blob_id
         WHERE a.message_id IN (${placeholders})
         ORDER BY a.rowid ASC`,
      )
      .all(...messageIds) as AttachmentRow[];
    for (const row of rows) {
      const items = result.get(row.message_id) ?? [];
      items.push({
        id: row.id,
        blobId: row.blob_id,
        kind: row.kind as AttachmentKind,
        displayName: row.display_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        contentUrl: `/v1/attachments/${encodeURIComponent(row.id)}/content`,
        createdAt: row.created_at as Iso8601,
      });
      result.set(row.message_id, items);
    }
    return result;
  }
}
