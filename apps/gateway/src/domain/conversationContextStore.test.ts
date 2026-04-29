import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../persistence/migrate";
import { openDatabase } from "../persistence/sqlite";
import { ConversationContextStore } from "./conversationContextStore";
import { ConversationStore } from "./conversationStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-context-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const store = new ConversationContextStore(db);
  const conversations = new ConversationStore(db);
  return {
    conversations,
    db,
    store,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

describe("ConversationContextStore", () => {
  test("adds, lists, pops, and clears session items", () => {
    const { conversations, store, cleanup } = fresh();
    try {
      const conversation = conversations.create({ agentId: "a-1", title: "Context" });
      store.addSessionItems(conversation.id, [
        {
          messageId: "m-1",
          role: "user",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
        {
          messageId: "m-2",
          role: "assistant",
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hi" }],
          },
        },
        {
          messageId: "m-3",
          role: "user",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "again" }],
          },
        },
      ]);

      expect(store.listSessionItems(conversation.id).map((item) => item.messageId)).toEqual([
        "m-1",
        "m-2",
        "m-3",
      ]);
      expect(store.listSessionItems(conversation.id, 2).map((item) => item.messageId)).toEqual([
        "m-2",
        "m-3",
      ]);
      expect(store.popSessionItem(conversation.id)?.messageId).toBe("m-3");
      expect(store.listSessionItems(conversation.id).map((item) => item.messageId)).toEqual([
        "m-1",
        "m-2",
      ]);

      store.clearSession(conversation.id);
      expect(store.listSessionItems(conversation.id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("upserts and reads context summary", () => {
    const { conversations, store, cleanup } = fresh();
    try {
      const conversation = conversations.create({ agentId: "a-1", title: "Context" });
      const created = store.upsertContext({
        conversationId: conversation.id,
        agentId: "a-1",
        summary: "Project code is alpha-17.",
        summarizedThroughMessageId: "m-9",
        inputItemCount: 10,
        inputCharCount: 900,
      });

      expect(created).toMatchObject({
        conversationId: conversation.id,
        agentId: "a-1",
        summary: "Project code is alpha-17.",
        summarizedThroughMessageId: "m-9",
        inputItemCount: 10,
        inputCharCount: 900,
      });

      const updated = store.upsertContext({
        conversationId: conversation.id,
        agentId: "a-2",
        summary: "Updated summary.",
        summarizedThroughMessageId: null,
        inputItemCount: 11,
        inputCharCount: 950,
      });

      expect(updated).toMatchObject({
        conversationId: conversation.id,
        agentId: "a-2",
        summary: "Updated summary.",
        summarizedThroughMessageId: null,
        inputItemCount: 11,
        inputCharCount: 950,
      });
      expect(store.getContext(conversation.id)).toMatchObject(updated);
    } finally {
      cleanup();
    }
  });

  test("skips invalid session JSON instead of throwing", () => {
    const { conversations, db, store, cleanup } = fresh();
    try {
      const conversation = conversations.create({ agentId: "a-1", title: "Context" });
      store.addSessionItems(conversation.id, [
        {
          messageId: "m-1",
          role: "user",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
      ]);
      db.query(
        "INSERT INTO conversation_session_items(id, conversation_id, message_id, role, item_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("bad", conversation.id, "m-bad", "user", "{bad", new Date().toISOString());

      expect(store.listSessionItems(conversation.id).map((item) => item.messageId)).toEqual([
        "m-1",
      ]);
    } finally {
      cleanup();
    }
  });

  test("deleteConversation removes context and session items", () => {
    const { conversations, store, cleanup } = fresh();
    try {
      const conversation = conversations.create({ agentId: "a-1", title: "Context" });
      store.addSessionItems(conversation.id, [
        {
          messageId: "m-1",
          role: "user",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
      ]);
      store.upsertContext({
        conversationId: conversation.id,
        agentId: "a-1",
        summary: "summary",
        summarizedThroughMessageId: "m-1",
        inputItemCount: 1,
        inputCharCount: 5,
      });

      store.deleteConversation(conversation.id);

      expect(store.listSessionItems(conversation.id)).toEqual([]);
      expect(store.getContext(conversation.id)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("deleting a real conversation cascades context and session cleanup", () => {
    const { conversations, store, cleanup } = fresh();
    try {
      const conversation = conversations.create({ agentId: "a-1", title: "Context" });
      store.addSessionItems(conversation.id, [
        {
          messageId: "m-1",
          role: "user",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
      ]);
      store.upsertContext({
        conversationId: conversation.id,
        agentId: "a-1",
        summary: "summary",
        summarizedThroughMessageId: "m-1",
        inputItemCount: 1,
        inputCharCount: 5,
      });

      conversations.delete(conversation.id);

      expect(store.listSessionItems(conversation.id)).toEqual([]);
      expect(store.getContext(conversation.id)).toBeNull();
    } finally {
      cleanup();
    }
  });
});
