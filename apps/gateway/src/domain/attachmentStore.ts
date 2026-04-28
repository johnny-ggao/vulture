import type { DB } from "../persistence/sqlite";
import type {
  MessageAttachment,
  AttachmentKind,
} from "@vulture/protocol/src/v1/conversation";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path, { join } from "node:path";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface CreateDraftInput {
  bytes: Uint8Array;
  originalName: string;
  mimeType: string;
}

export interface AttachmentContent {
  attachment: MessageAttachment;
  bytes: Buffer;
  storagePath: string;
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  blob_id: string;
  kind: string;
  display_name: string;
  created_at: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
}

function attachmentId(): string {
  return `att-${crypto.randomUUID()}`;
}

function blobId(): string {
  return `blob-${crypto.randomUUID()}`;
}

function toAttachment(row: AttachmentRow): MessageAttachment {
  return {
    id: row.id,
    blobId: row.blob_id,
    kind: row.kind as AttachmentKind,
    displayName: row.display_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    contentUrl: `/v1/attachments/${encodeURIComponent(row.id)}/content`,
    createdAt: row.created_at as Iso8601,
  };
}

export class AttachmentStore {
  constructor(
    private readonly db: DB,
    private readonly profileDir: string,
  ) {}

  async createDraft(input: CreateDraftInput): Promise<MessageAttachment> {
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("attachment.too_large");
    }
    const id = attachmentId();
    const blob = blobId();
    const now = nowIso8601();
    const mimeType = input.mimeType.trim() || "application/octet-stream";
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const storagePath = join("blobs", sha256.slice(0, 2), blob);
    const absolutePath = this.resolveStoragePath(storagePath);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.bytes);

    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO blobs(id, sha256, mime_type, size_bytes, storage_path, original_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          blob,
          sha256,
          mimeType,
          input.bytes.byteLength,
          storagePath,
          input.originalName || "attachment",
          now,
        );
      this.db
        .query(
          `INSERT INTO message_attachments(id, message_id, blob_id, kind, display_name, created_at)
           VALUES (?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          blob,
          mimeType.startsWith("image/") ? "image" : "file",
          input.originalName || "attachment",
          now,
        );
    })();

    const row = this.getRow(id);
    if (!row) throw new Error("attachment.not_found");
    return toAttachment(row);
  }

  getContent(id: string): AttachmentContent | null {
    const row = this.getRow(id);
    if (!row) return null;
    const absolutePath = this.resolveStoragePath(row.storage_path);
    return {
      attachment: toAttachment(row),
      bytes: readFileSync(absolutePath),
      storagePath: row.storage_path,
    };
  }

  linkToMessage(attachmentIds: string[], messageId: string): void {
    if (attachmentIds.length > 10) throw new Error("attachment.too_many");
    this.db.transaction(() => {
      for (const id of attachmentIds) {
        const row = this.db
          .query("SELECT id, message_id FROM message_attachments WHERE id = ?")
          .get(id) as { id: string; message_id: string | null } | undefined;
        if (!row) throw new Error("attachment.not_found");
        if (row.message_id !== null) throw new Error("attachment.already_used");
        this.db
          .query("UPDATE message_attachments SET message_id = ? WHERE id = ?")
          .run(messageId, id);
      }
    })();
  }

  listForMessageIds(messageIds: string[]): MessageAttachment[] {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT a.id, a.message_id, a.blob_id, a.kind, a.display_name, a.created_at,
                b.mime_type, b.size_bytes, b.storage_path
         FROM message_attachments a
         JOIN blobs b ON b.id = a.blob_id
         WHERE a.message_id IN (${placeholders})
         ORDER BY a.rowid ASC`,
      )
      .all(...messageIds) as AttachmentRow[];
    return rows.map(toAttachment);
  }

  private getRow(id: string): AttachmentRow | null {
    const row = this.db
      .query(
        `SELECT a.id, a.message_id, a.blob_id, a.kind, a.display_name, a.created_at,
                b.mime_type, b.size_bytes, b.storage_path
         FROM message_attachments a
         JOIN blobs b ON b.id = a.blob_id
         WHERE a.id = ?`,
      )
      .get(id) as AttachmentRow | undefined;
    return row ?? null;
  }

  private resolveStoragePath(storagePath: string): string {
    const root = path.resolve(this.profileDir);
    const resolved = path.resolve(root, storagePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("attachment.invalid_path");
    }
    return resolved;
  }
}
