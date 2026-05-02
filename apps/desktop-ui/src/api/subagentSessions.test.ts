import { describe, expect, test } from "bun:test";
import type { ApiClient } from "./client";
import type { MessageDto } from "./conversations";
import { subagentSessionsApi, type SubagentSessionDto } from "./subagentSessions";

function fakeClient(handlers: Partial<ApiClient>): ApiClient {
  return {
    get: handlers.get ?? (async () => ({} as never)),
    post: handlers.post ?? (async () => ({} as never)),
    postForm: handlers.postForm ?? (async () => ({} as never)),
    put: handlers.put ?? (async () => ({} as never)),
    patch: handlers.patch ?? (async () => ({} as never)),
    delete: handlers.delete ?? (async () => undefined),
  } as ApiClient;
}

const session: SubagentSessionDto = {
  id: "sub-1",
  parentConversationId: "c-parent",
  parentRunId: "r-parent",
  agentId: "researcher",
  conversationId: "c-child",
  label: "Researcher",
  title: "Research SDK docs",
  task: "Read the SDK docs and summarize the useful parts.",
  status: "active",
  messageCount: 2,
  resultSummary: null,
  resultMessageId: null,
  completedAt: null,
  lastError: null,
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:01:00.000Z",
};

describe("subagentSessionsApi", () => {
  test("lists sessions by parent conversation", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/subagent-sessions?parentConversationId=c-parent&limit=20");
        return { items: [session] } as T;
      },
    });

    expect(
      await subagentSessionsApi.list(client, {
        parentConversationId: "c-parent",
        limit: 20,
      }),
    ).toEqual([session]);
  });

  test("lists sessions by parent conversation and run", async () => {
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe(
          "/v1/subagent-sessions?parentConversationId=c-parent&parentRunId=r-parent&limit=20",
        );
        return { items: [session] } as T;
      },
    });

    expect(
      await subagentSessionsApi.list(client, {
        parentConversationId: "c-parent",
        parentRunId: "r-parent",
        limit: 20,
      }),
    ).toEqual([session]);
  });

  test("loads messages for a session", async () => {
    const message: MessageDto = {
      id: "m-1",
      conversationId: "c-child",
      role: "assistant",
      content: "done",
      runId: "r-child",
      createdAt: "2026-04-30T00:02:00.000Z",
    };
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/subagent-sessions/sub-1/messages?limit=50");
        return { session, items: [message] } as T;
      },
    });

    expect(await subagentSessionsApi.messages(client, "sub-1")).toEqual({
      session,
      items: [message],
    });
  });
});
