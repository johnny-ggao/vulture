import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MessageDto } from "../api/conversations";
import type { SubagentSessionDto } from "../api/subagentSessions";
import { SubagentSessionPanel } from "./SubagentSessionPanel";

const session: SubagentSessionDto = {
  id: "sub-1",
  parentConversationId: "c-parent",
  parentRunId: "r-parent",
  agentId: "researcher",
  conversationId: "c-child",
  label: "Researcher",
  title: "Inspect dependency options",
  task: "Compare the supported approaches and call out the best fit.",
  status: "active",
  messageCount: 2,
  resultSummary: null,
  resultMessageId: null,
  completedAt: null,
  lastError: null,
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:01:00.000Z",
};

const messages: MessageDto[] = [
  {
    id: "m-1",
    conversationId: "c-child",
    role: "user",
    content: "find context",
    runId: null,
    createdAt: "2026-04-30T00:01:00.000Z",
  },
  {
    id: "m-2",
    conversationId: "c-child",
    role: "assistant",
    content: "context found",
    runId: "r-child",
    createdAt: "2026-04-30T00:02:00.000Z",
  },
];

describe("SubagentSessionPanel", () => {
  test("renders product-facing subtask title and task", () => {
    render(
      <SubagentSessionPanel
        sessions={[session]}
        messagesBySessionId={{}}
        loadingSessionIds={new Set()}
        onLoadMessages={async () => {}}
      />,
    );

    expect(screen.getByText("子任务")).toBeDefined();
    expect(screen.getByText("Inspect dependency options")).toBeDefined();
    expect(screen.getByText("Compare the supported approaches and call out the best fit.")).toBeDefined();
    expect(screen.getByText("运行中")).toBeDefined();
    expect(screen.queryByText(/2 条消息/)).toBeNull();
  });

  test("renders completed result summary without expansion", () => {
    render(
      <SubagentSessionPanel
        sessions={[
          {
            ...session,
            status: "completed",
            resultSummary: "The SDK manager pattern is the best fit.",
            completedAt: "2026-04-30T00:02:00.000Z",
          },
        ]}
        messagesBySessionId={{}}
        loadingSessionIds={new Set()}
        onLoadMessages={async () => {}}
      />,
    );

    expect(screen.getByText("已完成")).toBeDefined();
    expect(screen.getByText("The SDK manager pattern is the best fit.")).toBeDefined();
  });

  test("renders failed error without expansion", () => {
    render(
      <SubagentSessionPanel
        sessions={[
          {
            ...session,
            status: "failed",
            lastError: "child exploded",
          },
        ]}
        messagesBySessionId={{}}
        loadingSessionIds={new Set()}
        onLoadMessages={async () => {}}
      />,
    );

    expect(screen.getByText("失败")).toBeDefined();
    expect(screen.getByText("child exploded")).toBeDefined();
  });

  test("renders pending approval from an active child run", () => {
    const decisions: Array<{ runId: string; callId: string; decision: string }> = [];
    render(
      <SubagentSessionPanel
        sessions={[
          {
            ...session,
            pendingApprovals: [
              {
                runId: "r-child",
                callId: "c-read",
                tool: "read",
                reason: "read outside workspace requires approval",
                approvalToken: "tok-read",
                seq: 0,
              },
            ],
          },
        ]}
        messagesBySessionId={{}}
        loadingSessionIds={new Set()}
        submittingApprovalIds={new Set()}
        onLoadMessages={async () => {}}
        onDecideApproval={(runId, callId, decision) => {
          decisions.push({ runId, callId, decision });
        }}
      />,
    );

    expect(screen.getByText("需要批准")).toBeDefined();
    expect(screen.getByText("read outside workspace requires approval")).toBeDefined();
    fireEvent.click(screen.getByText("允许"));
    expect(decisions).toEqual([{ runId: "r-child", callId: "c-read", decision: "allow" }]);
  });

  test("does not render fallback failed token as inline detail", () => {
    render(
      <SubagentSessionPanel
        sessions={[
          {
            ...session,
            status: "failed",
            lastError: " failed ",
          },
        ]}
        messagesBySessionId={{}}
        loadingSessionIds={new Set()}
        onLoadMessages={async () => {}}
      />,
    );

    expect(screen.getByText("失败")).toBeDefined();
    expect(screen.queryByText(/^failed$/i)).toBeNull();
  });

  test("does not render fallback cancelled token as inline detail", () => {
    render(
      <SubagentSessionPanel
        sessions={[
          {
            ...session,
            status: "cancelled",
            lastError: "CANCELLED",
          },
        ]}
        messagesBySessionId={{}}
        loadingSessionIds={new Set()}
        onLoadMessages={async () => {}}
      />,
    );

    expect(screen.getByText("已取消")).toBeDefined();
    expect(screen.queryByText(/^cancelled$/i)).toBeNull();
  });

  test("loads and renders child messages when expanded", async () => {
    const loads: string[] = [];
    function Harness() {
      return (
        <SubagentSessionPanel
          sessions={[session]}
          messagesBySessionId={{ "sub-1": messages }}
          loadingSessionIds={new Set()}
          onLoadMessages={async (id) => {
            loads.push(id);
          }}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Inspect dependency options/ }));

    await waitFor(() => expect(loads).toEqual(["sub-1"]));
    expect(screen.getByText("find context")).toBeDefined();
    expect(screen.getByText("context found")).toBeDefined();
  });
});
