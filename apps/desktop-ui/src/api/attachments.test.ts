import { describe, expect, test } from "bun:test";
import { attachmentsApi } from "./attachments";
import type { ApiClient } from "./client";

describe("attachmentsApi", () => {
  test("upload posts multipart file field", async () => {
    let seenFile: File | null = null;
    const client = {
      postForm: async <T>(path: string, form: FormData) => {
        expect(path).toBe("/v1/attachments");
        seenFile = form.get("file") as File;
        return { id: "att-1", displayName: "note.txt" } as T;
      },
    } as ApiClient;

    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const result = await attachmentsApi.upload(client, file);

    expect(seenFile?.name).toBe("note.txt");
    expect(result.id).toBe("att-1");
  });
});
