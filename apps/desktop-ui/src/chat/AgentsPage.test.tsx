import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentsPage, type AgentConfigPatch } from "./AgentsPage";
import type { Agent, AgentCoreFilesResponse } from "../api/agents";
import { localAgentFixture as baseAgent } from "./__fixtures__/agent";

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

  // ---- Round 12: search + sort + count toolbar ----------------

  test("toolbar surfaces a search input and a count of total agents", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    expect(screen.getByLabelText("搜索智能体")).toBeDefined();
    expect(screen.getByText(/1\s*个智能体/)).toBeDefined();
  });

  test("typing in the search input filters the visible card list", () => {
    const robin: Agent = { ...baseAgent, id: "robin", name: "Robin" };
    const sage: Agent = { ...baseAgent, id: "sage", name: "Sage" };
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[robin, sage]}
        selectedAgentId="robin"
      />,
    );
    expect(container.querySelectorAll(".agent-card").length).toBe(2);
    fireEvent.change(screen.getByLabelText("搜索智能体"), {
      target: { value: "rob" },
    });
    // Only Robin matches "rob".
    expect(container.querySelectorAll(".agent-card").length).toBe(1);
    expect(screen.getByText("Robin")).toBeDefined();
    expect(screen.queryByText("Sage")).toBeNull();
    // Count chip shows the matched / total ratio.
    expect(screen.getByText("1 / 2")).toBeDefined();
  });

  test("when no agents match the search, an empty-results CTA appears", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    fireEvent.change(screen.getByLabelText("搜索智能体"), {
      target: { value: "no-match-here" },
    });
    expect(screen.getByText(/没有匹配的智能体/)).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "查看全部智能体" }),
    );
    expect(screen.queryByText(/没有匹配的智能体/)).toBeNull();
  });

  test("sort by alpha orders agents by name", () => {
    const robin: Agent = {
      ...baseAgent,
      id: "robin",
      name: "Robin",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const adam: Agent = {
      ...baseAgent,
      id: "adam",
      name: "Adam",
      updatedAt: "2026-05-01T00:00:00Z", // newer than Robin
    };
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[robin, adam]}
        selectedAgentId="robin"
      />,
    );
    // Default sort is "recent" → Adam (newer) first.
    let names = Array.from(container.querySelectorAll(".agent-card-name")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Adam", "Robin"]);

    // Round 13: sort dropdown → segmented pill control. Click the
    // "名称" radio.
    fireEvent.click(screen.getByRole("radio", { name: "名称" }));
    names = Array.from(container.querySelectorAll(".agent-card-name")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Adam", "Robin"]);
  });

  // ---- Round 13: dashed "create" tile in the grid -----------------

  test("renders a 新建智能体 create tile inside the grid", () => {
    const robin: Agent = { ...baseAgent, id: "robin", name: "Robin" };
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[robin]}
        selectedAgentId="robin"
      />,
    );
    const tile = container.querySelector(".agent-create-tile");
    expect(tile).not.toBeNull();
    expect(tile?.getAttribute("aria-label")).toBe("新建智能体");
  });

  test("clicking the grid create tile invokes onCreate", () => {
    const onCreate = mock(() => {});
    render(
      <AgentsPage
        {...stableProps}
        onCreate={onCreate}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    fireEvent.click(screen.getByLabelText("新建智能体"));
    expect(onCreate).toHaveBeenCalled();
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

  test("tools tab edits handoff agent ids", async () => {
    const onSave = mock(async (_id: string, _patch: AgentConfigPatch) => {});
    const researcher: Agent = {
      ...baseAgent,
      id: "researcher",
      name: "Researcher",
      description: "Finds facts",
      handoffAgentIds: [],
    };
    render(
      <AgentsPage
        {...stableProps}
        onSave={onSave}
        agents={[baseAgent, researcher]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.click(screen.getByRole("tab", { name: "工具" }));
    expect(screen.getByText("可用子智能体")).toBeTruthy();
    expect(screen.getByText("主智能体会自主判断是否建议开启，用户确认后才会创建子智能体。")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("允许建议开启 Researcher"));
    fireEvent.click(screen.getByRole("button", { name: /^保存/ }));

    const [, patch] = onSave.mock.calls[0]!;
    expect(patch.handoffAgentIds).toEqual(["researcher"]);
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

  // ---- Round 12: dirty-close confirm + Cmd+S save shortcut ------

  test("Escape on a dirty modal asks for confirmation; cancelling keeps the modal open", () => {
    const originalConfirm = window.confirm;
    let confirmCalls: string[] = [];
    (window as unknown as { confirm: (msg?: string) => boolean }).confirm = (
      msg?: string,
    ) => {
      confirmCalls.push(msg ?? "");
      return false;
    };
    try {
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
      fireEvent.keyDown(window, { key: "Escape" });
      expect(confirmCalls.length).toBe(1);
      expect(confirmCalls[0]).toMatch(/未保存/);
      // Modal stayed open (overview tab still visible).
      expect(screen.getByRole("tab", { name: "概览" })).toBeDefined();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("Esc on a clean modal does NOT prompt and closes immediately", () => {
    const originalConfirm = window.confirm;
    let confirmCalls = 0;
    (window as unknown as { confirm: () => boolean }).confirm = () => {
      confirmCalls += 1;
      return true;
    };
    try {
      render(
        <AgentsPage
          {...stableProps}
          agents={[baseAgent]}
          selectedAgentId="agent-1"
        />,
      );
      openEditModal();
      // No edits → not dirty.
      fireEvent.keyDown(window, { key: "Escape" });
      expect(confirmCalls).toBe(0);
      expect(screen.queryByRole("tab", { name: "概览" })).toBeNull();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("Cmd+S on a dirty modal saves; on a clean modal it is a no-op", async () => {
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

    // Clean: Cmd+S should NOT call onSave.
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(onSave).not.toHaveBeenCalled();

    // Dirty: Cmd+S triggers save.
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Renamed" },
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(onSave).toHaveBeenCalled();
    const [, patch] = onSave.mock.calls[0]!;
    expect(patch.name).toBe("Renamed");
  });

  // ---- Round 14: skills chip preview + ID copy chip + segmented tabs

  test("Skills field shows the default-state pill when the input is empty", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    // baseAgent has skills=null → skillsText defaults to "" → preview is "全部 Skills 可用".
    expect(screen.getByText("全部 Skills 可用")).toBeDefined();
  });

  test("Skills field shows 已禁用 pill when the input is 'none'", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.change(screen.getByLabelText("Skills"), {
      target: { value: "none" },
    });
    expect(screen.getByText("已禁用")).toBeDefined();
  });

  test("Skills field renders one chip per parsed entry", () => {
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.change(screen.getByLabelText("Skills"), {
      target: { value: "alpha, beta, gamma" },
    });
    const chips = container.querySelectorAll(".agent-skills-chip");
    expect(chips.length).toBe(3);
    expect(chips[0].textContent).toBe("alpha");
    expect(chips[2].textContent).toBe("gamma");
  });

  test("modal header surfaces the agent id as a copy chip", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    const chip = screen.getByLabelText(/复制 agent id agent-1/);
    expect(chip).toBeDefined();
    // The id appears inside the chip as monospaced code.
    expect(chip.querySelector("code")?.textContent).toBe("agent-1");
  });

  test("modal tabs are a Segmented radiogroup that keeps role=tab semantics", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    // Tablist still uses role=tablist + role=tab for screen readers,
    // but the buttons carry the .segmented-segment class so visual
    // styling stays consistent.
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(4);
    for (const tab of tabs) {
      expect(tab.classList.contains("segmented-segment")).toBe(true);
    }
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
