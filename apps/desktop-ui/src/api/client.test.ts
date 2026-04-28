import { describe, expect, test } from "bun:test";
import { createApiClient } from "./client";

describe("createApiClient", () => {
  test("includes method, path, and status in non-JSON errors", async () => {
    const client = createApiClient(
      { gateway: { port: 4099 }, token: "token" },
      {
        fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
      },
    );

    await expect(client.postForm("/v1/attachments", new FormData())).rejects.toThrow(
      "POST /v1/attachments -> HTTP 404",
    );
  });
});
