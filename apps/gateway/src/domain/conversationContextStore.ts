import type { AgentInputItem } from "@openai/agents";
import type { DB } from "../persistence/sqlite";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { brandId } from "@vulture/common";

export interface StoredSessionItem {
  id: string;
  conversationId: string;
  messageId: string | null;
  role: string;
  item: AgentInputItem;
  createdAt: Iso8601;
}

export interface AddSessionItemInput {
  messageId?: string | null;
  role: string;
  item: AgentInputItem;
}

export interface ConversationContext {
  conversationId: string;
  agentId: string;
  summary: string;
  summarizedThroughMessageId: string | null;
  inputItemCount: number;
  inputCharCount: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface UpsertConversationContextInput {
  conversationId: string;
  agentId: string;
  summary?: string;
  summarizedThroughMessageId?: string | null;
  inputItemCount?: number;
  inputCharCount?: number;
}

interface SessionItemRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  role: string;
  item_json: string;
  created_at: string;
}

interface ContextRow {
  conversation_id: string;
  agent_id: string;
  summary: string;
  summarized_through_message_id: string | null;
  input_item_count: number;
  input_char_count: number;
  created_at: string;
  updated_at: string;
}

function sessionItemId(): string {
  return brandId(`csi-${crypto.randomUUID()}`);
}

function rowToSessionItem(row: SessionItemRow): StoredSessionItem | null {
  try {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      role: row.role,
      item: JSON.parse(row.item_json) as AgentInputItem,
      createdAt: row.created_at as Iso8601,
    };
  } catch {
    return null;
  }
}

function rowToContext(row: ContextRow): ConversationContext {
  return {
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    summary: row.summary,
    summarizedThroughMessageId: row.summarized_through_message_id,
    inputItemCount: row.input_item_count,
    inputCharCount: row.input_char_count,
    createdAt: row.created_at as Iso8601,
    updatedAt: row.updated_at as Iso8601,
  };
}

export class ConversationContextStore {
  constructor(private readonly db: DB) {}

  listSessionItems(conversationId: string, limit?: number): StoredSessionItem[] {
    if (limit !== undefined && limit <= 0) return [];
    const rows =
      limit === undefined
        ? (this.db
            .query(
              "SELECT * FROM conversation_session_items WHERE conversation_id = ? ORDER BY rowid ASC",
            )
            .all(conversationId) as SessionItemRow[])
        : (this.db
            .query(
              `SELECT *
               FROM (
                 SELECT *, rowid AS row_order
                 FROM conversation_session_items
                 WHERE conversation_id = ?
                 ORDER BY rowid DESC
                 LIMIT ?
               )
               ORDER BY row_order ASC`,
            )
            .all(conversationId, Math.floor(limit)) as SessionItemRow[]);

    return rows.flatMap((row) => {
      const item = rowToSessionItem(row);
      return item ? [item] : [];
    });
  }

  addSessionItems(conversationId: string, items: AddSessionItemInput[]): void {
    if (items.length === 0) return;
    const insert = this.db.query(
      `INSERT INTO conversation_session_items(id, conversation_id, message_id, role, item_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const item of items) {
        insert.run(
          sessionItemId(),
          conversationId,
          item.messageId ?? null,
          item.role,
          JSON.stringify(item.item),
          nowIso8601(),
        );
      }
    })();
  }

  popSessionItem(conversationId: string): StoredSessionItem | undefined {
    const row = this.db
      .query(
        "SELECT * FROM conversation_session_items WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(conversationId) as SessionItemRow | undefined;
    if (!row) return undefined;

    this.db.query("DELETE FROM conversation_session_items WHERE id = ?").run(row.id);
    return rowToSessionItem(row) ?? undefined;
  }

  clearSession(conversationId: string): void {
    this.db
      .query("DELETE FROM conversation_session_items WHERE conversation_id = ?")
      .run(conversationId);
  }

  deleteSessionItemsForMessage(conversationId: string, messageId: string): void {
    this.db
      .query("DELETE FROM conversation_session_items WHERE conversation_id = ? AND message_id = ?")
      .run(conversationId, messageId);
  }

  getContext(conversationId: string): ConversationContext | null {
    const row = this.db
      .query("SELECT * FROM conversation_contexts WHERE conversation_id = ?")
      .get(conversationId) as ContextRow | undefined;
    return row ? rowToContext(row) : null;
  }

  upsertContext(input: UpsertConversationContextInput): ConversationContext {
    const now = nowIso8601();
    this.db
      .query(
        `INSERT INTO conversation_contexts(
           conversation_id,
           agent_id,
           summary,
           summarized_through_message_id,
           input_item_count,
           input_char_count,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           summary = excluded.summary,
           summarized_through_message_id = excluded.summarized_through_message_id,
           input_item_count = excluded.input_item_count,
           input_char_count = excluded.input_char_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.conversationId,
        input.agentId,
        input.summary ?? "",
        input.summarizedThroughMessageId ?? null,
        input.inputItemCount ?? 0,
        input.inputCharCount ?? 0,
        now,
        now,
      );
    return this.getContext(input.conversationId) as ConversationContext;
  }

  deleteConversation(conversationId: string): void {
    this.db.transaction(() => {
      this.db
        .query("DELETE FROM conversation_session_items WHERE conversation_id = ?")
        .run(conversationId);
      this.db
        .query("DELETE FROM conversation_contexts WHERE conversation_id = ?")
        .run(conversationId);
    })();
  }
}
