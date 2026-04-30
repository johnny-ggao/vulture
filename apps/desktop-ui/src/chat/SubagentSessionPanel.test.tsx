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
  status: "active",
  messageCount: 2,
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
  test("renders session status and message count", () => {
    render(
      <SubagentSessionPanel
        sessions={[session]}
        messagesBySessionId={{}}
        loadingSessionIds={new Set()}
        onLoadMessages={async () => {}}
      />,
    );

    expect(screen.getByText("子智能体")).toBeDefined();
    expect(screen.getByText("Researcher")).toBeDefined();
    expect(screen.getByText("运行中")).toBeDefined();
    expect(screen.getByText(/2 条消息/)).toBeDefined();
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
    fireEvent.click(screen.getByRole("button", { name: /Researcher/ }));

    await waitFor(() => expect(loads).toEqual(["sub-1"]));
    expect(screen.getByText("find context")).toBeDefined();
    expect(screen.getByText("context found")).toBeDefined();
  });
});
