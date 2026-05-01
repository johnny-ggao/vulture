import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";
import type { ApiClient } from "../api/client";
import type { ConversationDto, CreateConversationRequest, MessageDto } from "../api/conversations";
import type { RunDto } from "../api/runs";
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

function Probe(props: { client: ApiClient }) {
  const controller = useRunController({
    apiClient: props.client,
    selectedAgentId: "agent-a",
    conversations: conversationActions,
    streamFetch,
  });

  return (
    <div>
      <button onClick={() => void controller.send("hello world")}>send</button>
      <button onClick={() => void controller.changePermissionMode("read_only")}>read_only</button>
      <span data-testid="conversation">{controller.activeConversationId ?? ""}</span>
      <span data-testid="run">{controller.activeRunId ?? ""}</span>
      <span data-testid="permission">{controller.permissionMode}</span>
      <span data-testid="messages">{controller.messages.items.map((item) => item.id).join(",")}</span>
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
});
