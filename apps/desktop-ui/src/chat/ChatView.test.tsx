import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatView } from "./ChatView";
import type { MessageDto } from "../api/conversations";

const msgs: MessageDto[] = [
  {
    id: "m-1",
    conversationId: "c-1",
    role: "user",
    content: "hello",
    runId: null,
    createdAt: "2026-04-27T00:00:00.000Z",
  },
  {
    id: "m-2",
    conversationId: "c-1",
    role: "assistant",
    content: "hi back",
    runId: "r-1",
    createdAt: "2026-04-27T00:00:00.000Z",
  },
];

describe("ChatView", () => {
  test("renders historical messages", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={msgs}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("hello")).toBeDefined();
    expect(screen.getByText("hi back")).toBeDefined();
  });

  test("renders historical assistant token usage", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={msgs}
        messageUsages={new Map([
          ["r-1", { inputTokens: 100, outputTokens: 25, totalTokens: 125 }],
        ])}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("Tokens: 100 in · 25 out · 125 total")).toBeDefined();
  });

  test("shows reconnecting chip when status=reconnecting", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="reconnecting"
        runError="net"
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/重连中/)).toBeDefined();
  });

  test("shows empty state when no messages and idle", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/选择智能体/)).toBeDefined();
  });

  test("shows recovery actions when run is recoverable", async () => {
    const calls: string[] = [];
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={msgs.slice(0, 1)}
        runEvents={[
          {
            type: "run.recoverable",
            runId: "r-1",
            seq: 4,
            createdAt: "2026-04-27T00:00:00.000Z",
            reason: "incomplete_tool",
            message: "Tool shell.exec may have been interrupted before completion.",
          },
        ]}
        runStatus="recoverable"
        runError={null}
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => calls.push("cancel")}
        onResume={() => calls.push("resume")}
        onDecide={() => {}}
      />,
    );

    expect(screen.getByText(/可恢复/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "恢复运行" }));
    fireEvent.click(screen.getByRole("button", { name: "取消恢复" }));
    expect(calls).toEqual(["resume", "cancel"]);
  });

  test("recoverable run blocks new sends from the composer", async () => {
    const calls: string[] = [];
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={msgs.slice(0, 1)}
        runEvents={[
          {
            type: "run.recoverable",
            runId: "r-1",
            seq: 4,
            createdAt: "2026-04-27T00:00:00.000Z",
            reason: "incomplete_tool",
            message: "Tool shell.exec may have been interrupted before completion.",
          },
        ]}
        runStatus="recoverable"
        runError={null}
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => calls.push("send")}
        onCancel={() => calls.push("cancel")}
        onResume={() => calls.push("resume")}
        onDecide={() => {}}
      />,
    );

    const input = screen.getByPlaceholderText(/输入问题/) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "new work" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(calls).toEqual([]);
    expect(screen.queryByLabelText("发送")).toBeNull();
  });
});
