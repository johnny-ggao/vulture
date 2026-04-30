import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentCard } from "./AgentCard";
import type { Agent } from "../../api/agents";

const baseAgent: Agent = {
  id: "agent-1",
  name: "Research Agent",
  description: "Long-form analysis with citations.",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: ["files.read", "shell.exec"],
  toolPreset: "developer",
  toolInclude: [],
  toolExclude: [],
  workspace: {
    id: "agent-1",
    name: "Research Agent",
    path: "/tmp/workspace",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  },
  instructions: "be helpful",
  createdAt: "2026-04-28T00:00:00.000Z",
  updatedAt: "2026-04-28T00:00:00.000Z",
} as Agent;

describe("AgentCard", () => {
  test("renders the agent name + description + model meta", () => {
    render(
      <AgentCard agent={baseAgent} onOpenEdit={() => {}} onOpenChat={() => {}} />,
    );
    expect(screen.getByText("Research Agent")).toBeDefined();
    expect(screen.getByText(/Long-form analysis/)).toBeDefined();
    expect(screen.getByText(/gpt-5\.4/)).toBeDefined();
  });

  test("clicking the card invokes onOpenEdit with the agent id", () => {
    const onOpenEdit = mock((_id: string) => {});
    render(
      <AgentCard
        agent={baseAgent}
        onOpenEdit={onOpenEdit}
        onOpenChat={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Research Agent" }),
    );
    expect(onOpenEdit).toHaveBeenCalledWith("agent-1");
  });

  test("'打开对话' action invokes onOpenChat without bubbling to card", () => {
    const onOpenEdit = mock((_id: string) => {});
    const onOpenChat = mock((_id: string) => {});
    render(
      <AgentCard
        agent={baseAgent}
        onOpenEdit={onOpenEdit}
        onOpenChat={onOpenChat}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /打开对话.*Research Agent/ }));
    expect(onOpenChat).toHaveBeenCalledWith("agent-1");
    expect(onOpenEdit).not.toHaveBeenCalled();
  });

  test("renders a delete action only when onDelete is provided", () => {
    const onDelete = mock((_id: string) => {});
    const { rerender } = render(
      <AgentCard
        agent={baseAgent}
        onOpenEdit={() => {}}
        onOpenChat={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /删除.*Research Agent/ })).toBeNull();

    rerender(
      <AgentCard
        agent={baseAgent}
        onOpenEdit={() => {}}
        onOpenChat={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除.*Research Agent/ }));
    expect(onDelete).toHaveBeenCalledWith("agent-1");
  });

  test("shows tools count meta when the agent has tools", () => {
    render(
      <AgentCard agent={baseAgent} onOpenEdit={() => {}} onOpenChat={() => {}} />,
    );
    // Round 12: meta is now a chip with count + label split into spans;
    // the accessible name combines them.
    expect(screen.getByLabelText("2 工具")).toBeDefined();
  });

  test("does not show tools count when the agent has no tools", () => {
    const empty = { ...baseAgent, tools: [] as Agent["tools"] };
    const { container } = render(
      <AgentCard agent={empty} onOpenEdit={() => {}} onOpenChat={() => {}} />,
    );
    // No tools chip is rendered when count = 0.
    const chips = Array.from(container.querySelectorAll(".agent-card-chip"));
    expect(chips.some((chip) => /工具/.test(chip.getAttribute("aria-label") ?? ""))).toBe(false);
  });
});
