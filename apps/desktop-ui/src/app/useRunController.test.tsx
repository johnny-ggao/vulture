import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";
import type { ApiClient } from "../api/client";
import type { ConversationDto, CreateConversationRequest, MessageDto } from "../api/conversations";
import type { RunDto } from "../api/runs";
import type { SubagentSessionDto } from "../api/subagentSessions";
import { useRunController } from "./useRunController";

const now = "2026-01-01T00:00:00.000Z";

const conversation: ConversationDto = {
  id: "conversation-a",
  agentId: "agent-a",
  title: "hello",
  createdAt: now,
  updatedAt: now,
  permissionMode: "default",
};

const message: MessageDto = {
  id: "message-a",
  conversationId: "conversation-a",
  role: "user",
  content: "hello world",
  runId: "run-a",
  createdAt: now,
};

const run: RunDto = {
  id: "run-a",
  conversationId: "conversation-a",
  agentId: "agent-a",
  status: "running",
  triggeredByMessageId: "message-a",
  resultMessageId: null,
  startedAt: now,
  endedAt: null,
  error: null,
  usage: null,
};

const childSession: SubagentSessionDto = {
  id: "sub-1",
  parentConversationId: "conversation-a",
  parentRunId: "run-a",
  agentId: "agent-a",
  conversationId: "conversation-child-a",
  label: "Researcher",
  title: "Inspect context",
  task: "Inspect context",
  status: "active",
  messageCount: 1,
  resultSummary: null,
  resultMessageId: null,
  completedAt: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};

const streamFetch: typeof fetch = async () =>
  new Response(new ReadableStream(), {
    headers: { "content-type": "text/event-stream" },
  });

let createRequests: CreateConversationRequest[] = [];
const conversationActions = {
  create: async (req: CreateConversationRequest) => {
    createRequests.push(req);
    return { ...conversation, permissionMode: req.permissionMode ?? "default" };
  },
  refetch: async () => undefined,
};

function clientReturning(values: {
  get: Record<string, unknown>;
  post: Record<string, unknown>;
}): ApiClient {
  return {
    base: "http://127.0.0.1:4099",
    token: "token",
    get: async (path) => values.get[path] as never,
    post: async (path) => values.post[path] as never,
    postForm: async () => undefined as never,
    put: async () => undefined as never,
    patch: async () => undefined as never,
    delete: async () => undefined,
  };
}

function Probe(props: { client: ApiClient; subagentSessionsPollMs?: number }) {
  const controller = useRunController({
    apiClient: props.client,
    selectedAgentId: "agent-a",
    conversations: conversationActions,
    streamFetch,
    subagentSessionsPollMs: props.subagentSessionsPollMs,
  });

  return (
    <div>
      <button onClick={() => void controller.send("hello world")}>send</button>
      <button onClick={() => void controller.changePermissionMode("read_only")}>read_only</button>
      <button onClick={() => void controller.loadSubagentMessages("sub-1")}>load-subagent-1</button>
      <span data-testid="conversation">{controller.activeConversationId ?? ""}</span>
      <span data-testid="run">{controller.activeRunId ?? ""}</span>
      <span data-testid="permission">{controller.permissionMode}</span>
      <span data-testid="messages">{controller.messages.items.map((item) => item.id).join(",")}</span>
      <span data-testid="subagent-sessions">
        {controller.subagentSessions.map((item) => `${item.id}:${item.parentRunId}:${item.status}`).join(",")}
      </span>
      <span data-testid="subagent-message-keys">
        {Object.keys(controller.subagentMessages)
          .sort()
          .join(",")}
      </span>
    </div>
  );
}

describe("useRunController", () => {
  beforeEach(() => {
    localStorage.clear();
    createRequests = [];
  });

  test("creates a conversation and starts a run when sending without an active conversation", async () => {
    render(
      <Probe
        client={clientReturning({
          get: {
            "/v1/conversations/conversation-a": conversation,
            "/v1/conversations/conversation-a/messages": { items: [message] },
            "/v1/conversations/conversation-a/runs": { items: [] },
            "/v1/conversations/conversation-a/runs?status=active": { items: [run] },
            "/v1/runs/run-a": run,
            "/v1/subagent-sessions?parentConversationId=conversation-a&limit=20": { items: [] },
            "/v1/subagent-sessions?parentConversationId=conversation-a&parentRunId=run-a&limit=20": {
              items: [],
            },
          },
          post: {
            "/v1/conversations/conversation-a/runs": { run, message },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByText("send"));

    await waitFor(() => expect(screen.getByTestId("conversation").textContent).toBe("conversation-a"));
    await waitFor(() => expect(screen.getByTestId("run").textContent).toBe("run-a"));
    await waitFor(() => expect(screen.getByTestId("messages").textContent).toBe("message-a"));
  });

  test("uses the selected permission mode when creating a new conversation", async () => {
    render(
      <Probe
        client={clientReturning({
          get: {
            "/v1/conversations/conversation-a": { ...conversation, permissionMode: "read_only" },
            "/v1/conversations/conversation-a/messages": { items: [message] },
            "/v1/conversations/conversation-a/runs": { items: [] },
            "/v1/conversations/conversation-a/runs?status=active": { items: [run] },
            "/v1/runs/run-a": run,
            "/v1/subagent-sessions?parentConversationId=conversation-a&limit=20": { items: [] },
            "/v1/subagent-sessions?parentConversationId=conversation-a&parentRunId=run-a&limit=20": {
              items: [],
            },
          },
          post: {
            "/v1/conversations/conversation-a/runs": { run, message },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByText("read_only"));
    await waitFor(() => expect(screen.getByTestId("permission").textContent).toBe("read_only"));
    fireEvent.click(screen.getByText("send"));

    await waitFor(() => expect(createRequests[0]).toMatchObject({ permissionMode: "read_only" }));
  });

  test("scopes subagent sessions to the active run and clears stale child state when the run changes", async () => {
    const getPaths: string[] = [];
    let createdRuns = 0;
    const firstRun = { ...run, id: "run-a" };
    const secondRun = { ...run, id: "run-b" };
    const firstMessage = { ...message, id: "message-a", runId: "run-a" };
    const secondMessage = { ...message, id: "message-b", runId: "run-b", content: "follow up" };
    const firstSession = { ...childSession, id: "sub-1", parentRunId: "run-a" };
    const secondSession = {
      ...childSession,
      id: "sub-2",
      parentRunId: "run-b",
      conversationId: "conversation-child-b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };

    const client: ApiClient = {
      base: "http://127.0.0.1:4099",
      token: "token",
      get: async (path) => {
        getPaths.push(path);
        if (path === "/v1/conversations/conversation-a") return conversation as never;
        if (path === "/v1/conversations/conversation-a/messages") return { items: [] } as never;
        if (path === "/v1/conversations/conversation-a/runs") return { items: [] } as never;
        if (path === "/v1/conversations/conversation-a/runs?status=active") {
          return { items: [firstRun] } as never;
        }
        if (path === "/v1/subagent-sessions?parentConversationId=conversation-a&limit=20") {
          return { items: [] } as never;
        }
        if (path === "/v1/subagent-sessions?parentConversationId=conversation-a&parentRunId=run-a&limit=20") {
          return { items: [firstSession] } as never;
        }
        if (path === "/v1/subagent-sessions?parentConversationId=conversation-a&parentRunId=run-b&limit=20") {
          return { items: [secondSession] } as never;
        }
        if (path === "/v1/subagent-sessions/sub-1/messages?limit=50") {
          return { session: firstSession, items: [{ ...message, id: "child-message", runId: "run-child" }] } as never;
        }
        throw new Error(`Unexpected GET ${path}`);
      },
      post: async (path) => {
        if (path !== "/v1/conversations/conversation-a/runs") {
          throw new Error(`Unexpected POST ${path}`);
        }
        createdRuns += 1;
        if (createdRuns === 1) return { run: firstRun, message: firstMessage } as never;
        return { run: secondRun, message: secondMessage } as never;
      },
      postForm: async () => undefined as never,
      put: async () => undefined as never,
      patch: async () => undefined as never,
      delete: async () => undefined,
    };

    render(<Probe client={client} />);

    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(screen.getByTestId("run").textContent).toBe("run-a"));
    await waitFor(() =>
      expect(screen.getByTestId("subagent-sessions").textContent).toBe("sub-1:run-a:active"),
    );

    fireEvent.click(screen.getByText("load-subagent-1"));
    await waitFor(() => expect(screen.getByTestId("subagent-message-keys").textContent).toBe("sub-1"));

    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(screen.getByTestId("run").textContent).toBe("run-b"));
    await waitFor(() =>
      expect(screen.getByTestId("subagent-sessions").textContent).toBe("sub-2:run-b:active"),
    );
    await waitFor(() => expect(screen.getByTestId("subagent-message-keys").textContent).toBe(""));

    expect(getPaths).toContain(
      "/v1/subagent-sessions?parentConversationId=conversation-a&parentRunId=run-a&limit=20",
    );
    expect(getPaths).toContain(
      "/v1/subagent-sessions?parentConversationId=conversation-a&parentRunId=run-b&limit=20",
    );
  });

  test("polls active subagent sessions until they reach a terminal state", async () => {
    localStorage.setItem(
      "vulture.chat.active",
      JSON.stringify({ conversationId: "conversation-a", runId: "run-a" }),
    );

    let listCalls = 0;
    const client = clientReturning({
      get: {
        "/v1/conversations/conversation-a": conversation,
        "/v1/conversations/conversation-a/messages": { items: [] },
        "/v1/conversations/conversation-a/runs": { items: [] },
        "/v1/conversations/conversation-a/runs?status=active": { items: [run] },
      },
      post: {},
    });
    client.get = async (path) => {
      if (path === "/v1/subagent-sessions?parentConversationId=conversation-a&parentRunId=run-a&limit=20") {
        listCalls += 1;
        return {
          items: [
            {
              ...childSession,
              status: listCalls === 1 ? "active" : "completed",
              resultSummary: listCalls === 1 ? null : "done",
              completedAt: listCalls === 1 ? null : now,
            },
          ],
        } as never;
      }
      return ({
        "/v1/conversations/conversation-a": conversation,
        "/v1/conversations/conversation-a/messages": { items: [] },
        "/v1/conversations/conversation-a/runs": { items: [] },
        "/v1/conversations/conversation-a/runs?status=active": { items: [run] },
      } as Record<string, unknown>)[path] as never;
    };

    render(<Probe client={client} subagentSessionsPollMs={10} />);

    await waitFor(() =>
      expect(screen.getByTestId("subagent-sessions").textContent).toBe("sub-1:run-a:active"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("subagent-sessions").textContent).toBe("sub-1:run-a:completed"),
    );

    expect(listCalls).toBeGreaterThanOrEqual(2);
  });
});
