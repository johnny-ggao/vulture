import { describe, expect, test } from "bun:test";
import { runsApi, type CreateRunResponse, type RunDto } from "./runs";
import type { ApiClient } from "./client";

function fakeClient(handlers: Partial<ApiClient>): ApiClient {
  return {
    get: handlers.get ?? (async () => ({} as never)),
    post: handlers.post ?? (async () => ({} as never)),
    patch: handlers.patch ?? (async () => ({} as never)),
    delete: handlers.delete ?? (async () => undefined),
  } as ApiClient;
}

const sampleRun: RunDto = {
  id: "r-1",
  conversationId: "c-1",
  agentId: "a-1",
  status: "queued",
  triggeredByMessageId: "m-1",
  resultMessageId: null,
  startedAt: "2026-04-27T00:00:00.000Z",
  endedAt: null,
  error: null,
};

describe("runsApi", () => {
  test("create posts to nested path with input", async () => {
    const expected: CreateRunResponse = {
      run: sampleRun,
      message: {
        id: "m-1",
        conversationId: "c-1",
        role: "user",
        content: "hi",
        runId: null,
        createdAt: "2026-04-27T00:00:00.000Z",
      },
      eventStreamUrl: "/v1/runs/r-1/events",
    };
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/conversations/c-1/runs");
        expect(body).toEqual({ input: "hi" });
        return expected as T;
      },
    });
    expect(await runsApi.create(client, "c-1", { input: "hi" })).toEqual(expected);
  });

  test("get fetches the run", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/runs/r-1");
        return sampleRun as T;
      },
    });
    expect(await runsApi.get(client, "r-1")).toEqual(sampleRun);
  });

  test("listForConversation fetches filtered runs", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/conversations/c-1/runs?status=active");
        return { items: [sampleRun] } as T;
      },
    });
    expect(await runsApi.listForConversation(client, "c-1", { status: "active" })).toEqual([
      sampleRun,
    ]);
  });

  test("cancel posts to cancel path", async () => {
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/runs/r-1/cancel");
        expect(body).toEqual({});
        return sampleRun as T;
      },
    });
    await runsApi.cancel(client, "r-1");
  });

  test("approve posts callId + decision", async () => {
    const client = fakeClient({
      post: async <T>(path: string, body: unknown) => {
        expect(path).toBe("/v1/runs/r-1/approvals");
        expect(body).toEqual({ callId: "tool-call-1", decision: "allow" });
        return undefined as T;
      },
    });
    await runsApi.approve(client, "r-1", { callId: "tool-call-1", decision: "allow" });
  });
});
