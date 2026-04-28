import { Hono } from "hono";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "../domain/attachmentStore";

export function attachmentsRouter(store: AttachmentStore): Hono {
  const app = new Hono();

  app.post("/v1/attachments", async (c) => {
    const body = await c.req.parseBody().catch(() => ({}));
    const file = (body as Record<string, unknown>).file;
    if (!isUploadFile(file)) {
      return c.json(
        { code: "attachment.file_required", message: "multipart field 'file' is required" },
        400,
      );
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return c.json({ code: "attachment.too_large", message: "file exceeds 20 MB" }, 413);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const draft = await store.createDraft({
      bytes,
      originalName: file.name,
      mimeType: file.type || "application/octet-stream",
    });
    return c.json(draft, 201);
  });

  app.get("/v1/attachments/:id/content", (c) => {
    const content = store.getContent(c.req.param("id"));
    if (!content) {
      return c.json({ code: "attachment.not_found", message: c.req.param("id") }, 404);
    }
    return new Response(new Uint8Array(content.bytes), {
      headers: {
        "Content-Type": content.attachment.mimeType,
        "Content-Disposition": `inline; filename="${escapeDispositionName(
          content.attachment.displayName,
        )}"`,
      },
    });
  });

  return app;
}

function isUploadFile(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    "size" in value &&
    typeof (value as { size?: unknown }).size === "number"
  );
}

function escapeDispositionName(name: string): string {
  return name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
