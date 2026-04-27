import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
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
        onSend={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("hello")).toBeDefined();
    expect(screen.getByText("hi back")).toBeDefined();
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
        onSend={() => {}}
        onCancel={() => {}}
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
        onSend={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/选择智能体/)).toBeDefined();
  });
});
