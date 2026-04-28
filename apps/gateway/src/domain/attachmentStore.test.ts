import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "./attachmentStore";
import { ConversationStore } from "./conversationStore";
import { MessageStore } from "./messageStore";

function fresh() {
  const profileDir = mkdtempSync(join(tmpdir(), "vulture-attachments-"));
  const db = openDatabase(join(profileDir, "data.sqlite"));
  applyMigrations(db);
  return {
    profileDir,
    db,
    attachments: new AttachmentStore(db, profileDir),
    conversations: new ConversationStore(db),
    messages: new MessageStore(db),
    cleanup: () => {
      db.close();
      rmSync(profileDir, { recursive: true });
    },
  };
}

describe("AttachmentStore", () => {
  test("createDraft stores blob metadata and bytes under profile blobs", async () => {
    const { profileDir, attachments, cleanup } = fresh();

    const draft = await attachments.createDraft({
      bytes: new TextEncoder().encode("hello attachment"),
      originalName: "note.txt",
      mimeType: "text/plain",
    });

    expect(draft.kind).toBe("file");
    expect(draft.displayName).toBe("note.txt");
    expect(draft.mimeType).toBe("text/plain");
    expect(draft.sizeBytes).toBe(16);
    const content = attachments.getContent(draft.id);
    expect(content?.attachment.id).toBe(draft.id);
    expect(content?.bytes.toString("utf8")).toBe("hello attachment");
    expect(content?.storagePath.startsWith("blobs/")).toBe(true);
    expect(existsSync(join(profileDir, content!.storagePath))).toBe(true);
    expect(readFileSync(join(profileDir, content!.storagePath), "utf8")).toBe("hello attachment");

    cleanup();
  });

  test("image mime types create image attachments", async () => {
    const { attachments, cleanup } = fresh();

    const draft = await attachments.createDraft({
      bytes: new Uint8Array([1, 2, 3]),
      originalName: "shot.png",
      mimeType: "image/png",
    });

    expect(draft.kind).toBe("image");
    cleanup();
  });

  test("createDraft rejects files over the size limit", async () => {
    const { attachments, cleanup } = fresh();

    await expect(
      attachments.createDraft({
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
        originalName: "too-large.bin",
        mimeType: "application/octet-stream",
      }),
    ).rejects.toThrow("attachment.too_large");

    cleanup();
  });

  test("linkToMessage attaches drafts and rejects reuse", async () => {
    const { attachments, conversations, messages, cleanup } = fresh();
    const conversation = conversations.create({ agentId: "agent-1" });
    const message = messages.append({
      conversationId: conversation.id,
      role: "user",
      content: "see attached",
      runId: null,
    });
    const draft = await attachments.createDraft({
      bytes: new Uint8Array([1]),
      originalName: "a.bin",
      mimeType: "application/octet-stream",
    });

    attachments.linkToMessage([draft.id], message.id);

    expect(attachments.listForMessageIds([message.id])[0].id).toBe(draft.id);
    expect(() => attachments.linkToMessage([draft.id], message.id)).toThrow(
      "attachment.already_used",
    );
    expect(() => attachments.linkToMessage(["att-missing"], message.id)).toThrow(
      "attachment.not_found",
    );

    cleanup();
  });
});
