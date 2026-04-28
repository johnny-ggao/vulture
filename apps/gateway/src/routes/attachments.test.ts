import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { AttachmentStore } from "../domain/attachmentStore";
import { attachmentsRouter } from "./attachments";

function freshApp() {
  const profileDir = mkdtempSync(join(tmpdir(), "vulture-attachment-route-"));
  const db = openDatabase(join(profileDir, "data.sqlite"));
  applyMigrations(db);
  const store = new AttachmentStore(db, profileDir);
  const app = attachmentsRouter(store);
  return {
    app,
    cleanup: () => {
      db.close();
      rmSync(profileDir, { recursive: true });
    },
  };
}

describe("/v1/attachments route", () => {
  test("POST uploads a file and GET streams its content", async () => {
    const { app, cleanup } = freshApp();
    const body = new FormData();
    body.set("file", new Blob(["hello route"], { type: "text/plain" }), "note.txt");

    const upload = await app.request("http://localhost/v1/attachments", {
      method: "POST",
      body,
    });

    expect(upload.status).toBe(201);
    const draft = await upload.json();
    expect(draft.displayName).toBe("note.txt");
    expect(draft.contentUrl).toBe(`/v1/attachments/${draft.id}/content`);

    const content = await app.request(draft.contentUrl);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toContain("text/plain");
    expect(await content.text()).toBe("hello route");
    cleanup();
  });

  test("POST rejects missing file field", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/attachments", {
      method: "POST",
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("attachment.file_required");
    cleanup();
  });
});
