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
    // Round 10: token usage moved from a plain text label to a pill.
    // Total is the headline number; in/out live in the title for hover.
    const total = screen.getByText("125");
    expect(total).toBeDefined();
    const pill = total.closest(".message-usage") as HTMLElement | null;
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("title") ?? "").toContain("100 in");
    expect(pill?.getAttribute("title") ?? "").toContain("25 out");
    expect(pill?.getAttribute("title") ?? "").toContain("125 total");
  });

  test("keeps retained tool blocks above the completed assistant reply", () => {
    const { container } = render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={msgs}
        runEvents={[
          {
            type: "tool.planned",
            runId: "r-1",
            seq: 1,
            createdAt: "2026-04-27T00:00:00.000Z",
            callId: "c1",
            tool: "read",
            input: { path: "package.json" },
          },
          {
            type: "tool.completed",
            runId: "r-1",
            seq: 2,
            createdAt: "2026-04-27T00:00:00.000Z",
            callId: "c1",
            output: { content: "ok" },
          },
        ]}
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

    const list = container.querySelector(".message-list") as HTMLElement;
    const children = Array.from(list.children);
    expect(children[0].classList.contains("message")).toBe(true);
    expect(children[1].classList.contains("run-event-stream")).toBe(true);
    expect(children[1].textContent).toContain("read");
    expect(children[2].classList.contains("message")).toBe(true);
    expect(children[2].textContent).toContain("hi back");
  });

  test("appends retained tool blocks after messages when their run is unmatched", () => {
    const { container } = render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={msgs}
        runEvents={[
          {
            type: "tool.planned",
            runId: "r-other",
            seq: 1,
            createdAt: "2026-04-27T00:00:00.000Z",
            callId: "c1",
            tool: "read",
            input: { path: "package.json" },
          },
        ]}
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

    const list = container.querySelector(".message-list") as HTMLElement;
    const children = Array.from(list.children);
    expect(children.at(-1)?.classList.contains("run-event-stream")).toBe(true);
    expect(children.at(-1)?.textContent).toContain("read");
  });

  test("renders subagent sessions below the current conversation", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={msgs}
        subagentSessions={[
          {
            id: "sub-1",
            parentConversationId: "c-1",
            parentRunId: "r-1",
            agentId: "researcher",
            conversationId: "c-child",
            label: "Researcher",
            title: "Researcher",
            task: null,
            status: "completed",
            messageCount: 3,
            resultSummary: null,
            resultMessageId: null,
            completedAt: null,
            lastError: null,
            createdAt: "2026-04-30T00:00:00.000Z",
            updatedAt: "2026-04-30T00:01:00.000Z",
          },
        ]}
        subagentMessages={{}}
        loadingSubagentMessages={new Set()}
        onLoadSubagentMessages={async () => {}}
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

    expect(screen.getByLabelText("子任务")).toBeDefined();
    expect(screen.getByText("Researcher")).toBeDefined();
    expect(screen.getByText("已完成")).toBeDefined();
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

  test("reconnect status uses role=status (polite live region)", () => {
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
    const status = screen.getByRole("status");
    expect(status.textContent ?? "").toMatch(/重连中/);
  });

  test("shows send error", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        sendError="attachment.file_required"
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("attachment.file_required")).toBeDefined();
  });

  test("send error uses role=alert (assertive live region)", () => {
    render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        sendError="attachment.file_required"
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").toContain("attachment.file_required");
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
    // Empty state now greets the active agent by name (你好，A) and
    // points to the next action ("直接输入任务，或从下面的建议挑一条开始。").
    expect(screen.getByRole("heading", { level: 2, name: "你好，A" })).toBeDefined();
    expect(screen.getByText(/直接输入任务/)).toBeDefined();
  });

  test("renders suggestion chips when provided", () => {
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
        suggestions={["帮我审查代码", "解释错误日志", "起草一份方案", "总结这份文档"]}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "帮我审查代码" })).toBeDefined();
    expect(screen.getByRole("button", { name: "解释错误日志" })).toBeDefined();
    expect(screen.getByRole("button", { name: "起草一份方案" })).toBeDefined();
    expect(screen.getByRole("button", { name: "总结这份文档" })).toBeDefined();
  });

  test("clicking a suggestion chip sends it as the next prompt", async () => {
    const calls: Array<{ text: string; files: number }> = [];
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
        suggestions={["帮我审查代码"]}
        onSend={(text, files) => {
          calls.push({ text, files: files.length });
        }}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "帮我审查代码" }));
    expect(calls).toEqual([{ text: "帮我审查代码", files: 0 }]);
  });

  test("does not render suggestions list when suggestions prop is empty/undefined", () => {
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
    expect(screen.queryByRole("button", { name: "帮我审查代码" })).toBeNull();
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

  // ---- Round 11: dismissible send-error banner -----------------

  test("send-error banner shows a dismiss button; clicking it hides the banner", () => {
    const { container, rerender } = render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        sendError="boom"
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("boom")).toBeDefined();
    const dismiss = container.querySelector(".status-banner-dismiss") as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    fireEvent.click(dismiss);
    // Same sendError prop value but now dismissed locally — banner hides.
    expect(container.querySelector(".status-banner.danger")).toBeNull();

    // A NEW error string re-shows the banner.
    rerender(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="idle"
        runError={null}
        sendError="another failure"
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("another failure")).toBeDefined();
  });

  test("reconnecting banner uses the spinning icon class", () => {
    const { container } = render(
      <ChatView
        agents={[{ id: "a1", name: "A" }]}
        selectedAgentId="a1"
        onSelectAgent={() => {}}
        messages={[]}
        runEvents={[]}
        runStatus="reconnecting"
        runError={null}
        submittingApprovals={new Set()}
        resumingRun={false}
        onSend={() => {}}
        onCancel={() => {}}
        onResume={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(container.querySelector(".status-banner-icon-spin")).not.toBeNull();
  });

  test("scroll-to-bottom FAB is hidden when the user is at the bottom", () => {
    const { container } = render(
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
    // happy-dom containers have scrollHeight=clientHeight by default,
    // so distance is 0 → stuck=true → FAB hidden.
    expect(container.querySelector(".chat-scroll-bottom")).toBeNull();
  });

  test("scroll-to-bottom FAB does not render on the empty state", () => {
    const { container } = render(
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
    expect(container.querySelector(".chat-scroll-bottom")).toBeNull();
  });
});
