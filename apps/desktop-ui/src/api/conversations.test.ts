import { describe, expect, test } from "bun:test";
import { conversationsApi, type ConversationDto } from "./conversations";
import type { ApiClient } from "./client";

function fakeClient(handlers: Partial<ApiClient>): ApiClient {
  return {
    get: handlers.get ?? (async () => ({} as never)),
    post: handlers.post ?? (async () => ({} as never)),
    patch: handlers.patch ?? (async () => ({} as never)),
    delete: handlers.delete ?? (async () => undefined),
  } as ApiClient;
}

const sample: ConversationDto = {
  id: "c-1",
  agentId: "local-work-agent",
  title: "Hello",
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
  permissionMode: "full_access",
};

describe("conversationsApi", () => {
  test("list strips items envelope", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations");
        return { items: [sample] } as T;
      },
    });
    expect(await conversationsApi.list(client)).toEqual([sample]);
  });

  test("list with agentId appends query", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations?agentId=a-1");
        return { items: [] } as T;
      },
    });
    await conversationsApi.list(client, { agentId: "a-1" });
  });

  test("create posts body and returns conv", async () => {
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/conversations");
        expect(body).toEqual({ agentId: "a-1", title: "Hi" });
        return sample as T;
      },
    });
    expect(await conversationsApi.create(client, { agentId: "a-1", title: "Hi" })).toEqual(sample);
  });

  test("create can send a conversation permission mode", async () => {
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/conversations");
        expect(body).toEqual({ agentId: "a-1", permissionMode: "policy" });
        return { ...sample, permissionMode: "policy" } as T;
      },
    });
    expect(await conversationsApi.create(client, { agentId: "a-1", permissionMode: "policy" })).toMatchObject({
      permissionMode: "policy",
    });
  });

  test("update patches permission mode", async () => {
    const client = fakeClient({
      patch: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/conversations/c-1");
        expect(body).toEqual({ permissionMode: "policy" });
        return { ...sample, permissionMode: "policy" } as T;
      },
    });
    expect(await conversationsApi.update(client, "c-1", { permissionMode: "policy" })).toMatchObject({
      permissionMode: "policy",
    });
  });

  test("listMessages without afterMessageId omits query", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations/c-1/messages");
        return { items: [] } as T;
      },
    });
    await conversationsApi.listMessages(client, "c-1");
  });

  test("listMessages with afterMessageId appends query", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations/c-1/messages?afterMessageId=m-2");
        return { items: [] } as T;
      },
    });
    await conversationsApi.listMessages(client, "c-1", "m-2");
  });

  test("delete sends DELETE", async () => {
    let called = false;
    const client = fakeClient({
      delete: async (path: string) => {
        expect(path).toBe("/v1/conversations/c-1");
        called = true;
      },
    });
    await conversationsApi.delete(client, "c-1");
    expect(called).toBe(true);
  });
});
