import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentsPage, type AgentConfigPatch } from "./AgentsPage";
import type { Agent, AgentCoreFilesResponse } from "../api/agents";

const baseAgent: Agent = {
  id: "agent-1",
  name: "Local Agent",
  description: "test agent",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: ["files.read"],
  toolPreset: "developer",
  toolInclude: ["files.read"],
  toolExclude: [],
  workspace: {
    id: "agent-1",
    name: "Local Agent",
    path: "/tmp/workspace",
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  },
  instructions: "behave",
  createdAt: "2026-04-28T00:00:00.000Z",
  updatedAt: "2026-04-28T00:00:00.000Z",
} as Agent;

const stableProps = {
  toolGroups: [],
  onCreate: () => {},
  onOpenChat: () => {},
  onSave: async (_id: string, _patch: AgentConfigPatch) => {},
  onListFiles: async (_id: string): Promise<AgentCoreFilesResponse> => ({
    corePath: "/tmp/agents/agent-1",
    files: [],
  }),
  onLoadFile: async () => "",
  onSaveFile: async () => {},
};

function openEditModal(agent: Agent = baseAgent) {
  fireEvent.click(screen.getByRole("button", { name: agent.name }));
}

describe("AgentsPage — browse view", () => {
  test("renders an empty state when there are no agents", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[]}
        selectedAgentId=""
      />,
    );
    expect(screen.getByText(/还没有智能体/)).toBeDefined();
    expect(screen.getByRole("button", { name: /创建第一个智能体/ })).toBeDefined();
  });

  test("renders an agent card for each agent", () => {
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    expect(container.querySelectorAll(".agent-card").length).toBe(1);
    expect(screen.getByText("Local Agent")).toBeDefined();
  });

  test("clicking a card opens the edit modal for that agent", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    expect(screen.queryByRole("tab", { name: "概览" })).toBeNull();
    openEditModal();
    expect(screen.getByRole("tab", { name: "概览" })).toBeDefined();
  });

  test("card delete button calls onDelete without opening the modal", () => {
    const onDelete = mock((_id: string) => {});
    render(
      <AgentsPage
        {...stableProps}
        onDelete={onDelete}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "删除智能体 Local Agent" }),
    );
    expect(onDelete).toHaveBeenCalledWith("agent-1");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  test("card open-chat action invokes onOpenChat without opening the modal", () => {
    const onOpenChat = mock((_id: string) => {});
    render(
      <AgentsPage
        {...stableProps}
        onOpenChat={onOpenChat}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /打开对话.*Local Agent/ }),
    );
    expect(onOpenChat).toHaveBeenCalledWith("agent-1");
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

describe("AgentsPage — edit modal", () => {
  test("modal exposes 概览 / Persona / 工具 / Agent Core tabs", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.getByRole("tab", { name: "概览" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Persona" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "工具" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Agent Core" })).toBeDefined();
  });

  test("clicking a tab switches the visible section", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.getByLabelText("名称")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Persona" }));
    expect(screen.getByLabelText("Instructions")).toBeDefined();
    expect(screen.queryByLabelText("名称")).toBeNull();
  });

  test("does NOT show the unsaved indicator when draft matches the agent", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.queryByText(/未保存/)).toBeNull();
  });

  test("shows the unsaved indicator after the user edits the name", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Renamed" },
    });
    expect(screen.getByText(/未保存/)).toBeDefined();
  });

  test("save button calls onSave with the edited draft", async () => {
    const onSave = mock(async (_id: string, _patch: AgentConfigPatch) => {});
    render(
      <AgentsPage
        {...stableProps}
        onSave={onSave}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^保存/ }));
    expect(onSave).toHaveBeenCalled();
    const [, patch] = onSave.mock.calls[0]!;
    expect(patch.name).toBe("Renamed");
  });

  test("close button dismisses the modal", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.getByRole("tab", { name: "概览" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("tab", { name: "概览" })).toBeNull();
  });

  test("Escape closes the modal", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.getByRole("tab", { name: "概览" })).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tab", { name: "概览" })).toBeNull();
  });

  test("modal closes if the agent disappears (e.g. delete-undo committed)", () => {
    const { rerender } = render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.getByRole("tab", { name: "概览" })).toBeDefined();

    rerender(
      <AgentsPage
        {...stableProps}
        agents={[]}
        selectedAgentId=""
      />,
    );
    expect(screen.queryByRole("tab", { name: "概览" })).toBeNull();
  });
});
