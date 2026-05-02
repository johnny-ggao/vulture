import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentsPage, type AgentConfigPatch } from "./AgentsPage";
import type { Agent, AgentCoreFilesResponse } from "../api/agents";
import { localAgentFixture as baseAgent } from "./__fixtures__/agent";

// Round 17: AgentsPage now persists sort + search via localStorage.
// Clear those keys before every test so writes from one test don't
// leak into the next (sort=alpha persisted by an earlier test made
// "Local Agent" sort to a non-default position and broke the
// open-modal helper that finds the agent by name).
beforeEach(() => {
  try {
    localStorage.removeItem("vulture.agents.sort");
    localStorage.removeItem("vulture.agents.search");
  } catch {
    // happy-dom always provides localStorage; the catch is for the
    // remote chance the host disabled it.
  }
});

const stableProps = {
  toolGroups: [],
  onCreate: async (_patch: AgentConfigPatch) => {},
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
    expect(screen.queryByRole("tab", { name: "基本信息" })).toBeNull();
    openEditModal();
    expect(screen.getByRole("tab", { name: "基本信息" })).toBeDefined();
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

  test("clicking the grid create tile opens the editor in create mode", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    fireEvent.click(screen.getByLabelText("新建智能体"));
    // Hero shows the placeholder name and the save button label is
    // "创建" instead of "保存".
    expect(
      screen.getByRole("heading", { name: "新建智能体", level: 2 }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /^创建/ })).toBeDefined();
  });
});

describe("AgentsPage — edit modal", () => {
  test("modal exposes 基本信息 / 人格 / 技能 / 协作 / 核心文件 tabs", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.getByRole("tab", { name: "基本信息" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "人格" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "技能" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "协作" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "核心文件" })).toBeDefined();
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

    fireEvent.click(screen.getByRole("tab", { name: "人格" }));
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

  test("协作 tab edits handoff agent ids", async () => {
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
    fireEvent.click(screen.getByRole("tab", { name: "协作" }));
    expect(screen.getByText("可用子智能体")).toBeTruthy();

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
    expect(screen.getByRole("tab", { name: "基本信息" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("tab", { name: "基本信息" })).toBeNull();
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
    expect(screen.getByRole("tab", { name: "基本信息" })).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tab", { name: "基本信息" })).toBeNull();
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
      expect(screen.getByRole("tab", { name: "基本信息" })).toBeDefined();
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
      expect(screen.queryByRole("tab", { name: "基本信息" })).toBeNull();
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
    expect(tabs.length).toBe(5);
    for (const tab of tabs) {
      expect(tab.classList.contains("segmented-segment")).toBe(true);
    }
  });

  // ---- Round 15: per-tab dirty dot + save error + persona starters

  test("editing a Persona-tab field shows the dirty dot only on the Persona tab", () => {
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    // Switch to Persona tab and edit Instructions.
    fireEvent.click(screen.getByRole("tab", { name: "人格" }));
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "be precise" },
    });
    // The Persona tab now carries a dot; Overview / 工具 do not.
    const personaTab = screen.getByRole("tab", { name: "人格" });
    expect(personaTab.querySelector(".agent-config-tab-dot")).not.toBeNull();
    const overviewTab = screen.getByRole("tab", { name: "基本信息" });
    expect(overviewTab.querySelector(".agent-config-tab-dot")).toBeNull();
    // Tab class also picks up has-changes for CSS hooks.
    expect(personaTab.classList.contains("has-changes")).toBe(true);
    // Confirm there's at least one dot in the tablist (sanity).
    expect(container.querySelectorAll(".agent-config-tab-dot").length).toBe(1);
  });

  test("save error from onSave surfaces an inline alert with retry + dismiss", async () => {
    let calls = 0;
    const onSave = async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
    };
    const { container } = render(
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
    await new Promise((r) => setTimeout(r, 0));
    // Error alert visible.
    const alert = container.querySelector(".agent-edit-error");
    expect(alert).not.toBeNull();
    expect(alert?.textContent ?? "").toContain("network down");

    // Click 重试 — second call to onSave succeeds, alert disappears.
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(container.querySelector(".agent-edit-error")).toBeNull();
  });

  test("save error dismiss button hides the alert without retrying", async () => {
    const onSave = async () => {
      throw new Error("boom");
    };
    const { container } = render(
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
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".agent-edit-error")).not.toBeNull();

    fireEvent.click(
      container.querySelector(".agent-edit-error-dismiss") as HTMLButtonElement,
    );
    expect(container.querySelector(".agent-edit-error")).toBeNull();
  });

  test("save button shows a Cmd+S kbd hint when not saving and not disabled", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    // Make dirty so the save button is enabled.
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Renamed" },
    });
    const saveBtn = screen.getByRole("button", { name: /^保存/ });
    expect(saveBtn.querySelector(".agent-edit-save-kbd")).not.toBeNull();
  });

  test("PersonaTab starters are visible only when Instructions is empty", () => {
    const { rerender } = render(
      <AgentsPage
        {...stableProps}
        agents={[{ ...baseAgent, instructions: "" }]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal({ ...baseAgent, instructions: "" });
    fireEvent.click(screen.getByRole("tab", { name: "人格" }));
    expect(screen.getByText("从模板开始：")).toBeDefined();
    expect(screen.getByRole("button", { name: "通用助手" })).toBeDefined();

    // Once the user types, the starter row hides.
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "x" },
    });
    expect(screen.queryByText("从模板开始：")).toBeNull();

    rerender(
      <AgentsPage
        {...stableProps}
        agents={[{ ...baseAgent, instructions: "" }]}
        selectedAgentId="agent-1"
      />,
    );
  });

  test("clicking a Persona starter chip seeds the Instructions textarea", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[{ ...baseAgent, instructions: "" }]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal({ ...baseAgent, instructions: "" });
    fireEvent.click(screen.getByRole("tab", { name: "人格" }));
    fireEvent.click(screen.getByRole("button", { name: "代码审阅" }));
    const ta = screen.getByLabelText("Instructions") as HTMLTextAreaElement;
    expect(ta.value).toContain("代码审阅者");
    expect(ta.value.length).toBeGreaterThan(50);
  });

  test("workspace block shows a copy button for the path", () => {
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    // Modal header carries the agent ID copy chip; the OverviewTab
    // also carries a separate copy button for the workspace path.
    // We pick the workspace button by its aria-label.
    const copyBtn = container.querySelector(
      `button[aria-label="复制 ${baseAgent.workspace.path}"]`,
    );
    expect(copyBtn).not.toBeNull();
  });

  // ---- Round 17: sort persistence + tablist arrow keys + revert ----

  test("sort choice persists across remounts via localStorage", () => {
    try {
      localStorage.removeItem("vulture.agents.sort");
    } catch {
      // ignore — happy-dom always provides localStorage
    }
    const robin: Agent = { ...baseAgent, id: "robin", name: "Robin" };
    const adam: Agent = {
      ...baseAgent,
      id: "adam",
      name: "Adam",
      updatedAt: "2026-05-01T00:00:00Z",
    };
    const { unmount, container } = render(
      <AgentsPage
        {...stableProps}
        agents={[robin, adam]}
        selectedAgentId="robin"
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "名称" }));
    // Adam first by name (alpha order, A < R).
    let names = Array.from(container.querySelectorAll(".agent-card-name")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Adam", "Robin"]);
    unmount();

    const { container: c2 } = render(
      <AgentsPage
        {...stableProps}
        agents={[robin, adam]}
        selectedAgentId="robin"
      />,
    );
    // Sort selection survived the remount.
    expect(
      screen
        .getByRole("radio", { name: "名称" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    names = Array.from(c2.querySelectorAll(".agent-card-name")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Adam", "Robin"]);
  });

  test("search query persists across remounts via localStorage", () => {
    try {
      localStorage.removeItem("vulture.agents.search");
      localStorage.removeItem("vulture.agents.sort");
    } catch {
      // ignore
    }
    const robin: Agent = { ...baseAgent, id: "robin", name: "Robin" };
    const sage: Agent = { ...baseAgent, id: "sage", name: "Sage" };
    const { unmount, container } = render(
      <AgentsPage
        {...stableProps}
        agents={[robin, sage]}
        selectedAgentId="robin"
      />,
    );
    fireEvent.change(screen.getByLabelText("搜索智能体"), {
      target: { value: "rob" },
    });
    expect(container.querySelectorAll(".agent-card").length).toBe(1);
    unmount();

    render(
      <AgentsPage
        {...stableProps}
        agents={[robin, sage]}
        selectedAgentId="robin"
      />,
    );
    // Search input retains the persisted value.
    const input = screen.getByLabelText("搜索智能体") as HTMLInputElement;
    expect(input.value).toBe("rob");
  });

  // ---- Round 17: tablist arrow keys + revert + tool filter + sort persist

  test("ArrowRight on the modal tablist moves to the next tab; ArrowLeft goes back", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    // Initially Overview is selected.
    expect(
      (
        screen.getByRole("tab", { name: "基本信息" }) as HTMLElement
      ).getAttribute("aria-selected"),
    ).toBe("true");
    // Fire ArrowRight on the tablist; aria-selected should flip to Persona.
    const tablist = screen.getByRole("tablist", { name: "智能体配置" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("tab", { name: "人格" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(
      (
        screen.getByRole("tab", { name: "基本信息" }) as HTMLElement
      ).getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("End jumps to the last tab; Home jumps to the first", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    const tablist = screen.getByRole("tablist", { name: "智能体配置" });
    fireEvent.keyDown(tablist, { key: "End" });
    expect(
      screen
        .getByRole("tab", { name: "核心文件" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(
      (
        screen.getByRole("tab", { name: "基本信息" }) as HTMLElement
      ).getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("revert-changes button appears only while dirty and restores the draft on confirm", () => {
    const originalConfirm = window.confirm;
    (window as unknown as { confirm: () => boolean }).confirm = () => true;
    try {
      render(
        <AgentsPage
          {...stableProps}
          agents={[baseAgent]}
          selectedAgentId="agent-1"
        />,
      );
      openEditModal();
      // Not dirty → no revert button.
      expect(screen.queryByRole("button", { name: "撤销修改" })).toBeNull();

      // Edit name → revert button appears.
      const nameInput = screen.getByLabelText("名称") as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "Renamed" } });
      expect(screen.getByRole("button", { name: "撤销修改" })).toBeDefined();

      // Click revert → confirms (mocked true) → name resets to fixture's name.
      fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
      expect(nameInput.value).toBe(baseAgent.name);
      // Revert button gone again.
      expect(screen.queryByRole("button", { name: "撤销修改" })).toBeNull();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test("revert cancellation keeps the dirty draft intact", () => {
    const originalConfirm = window.confirm;
    (window as unknown as { confirm: () => boolean }).confirm = () => false;
    try {
      render(
        <AgentsPage
          {...stableProps}
          agents={[baseAgent]}
          selectedAgentId="agent-1"
        />,
      );
      openEditModal();
      const nameInput = screen.getByLabelText("名称") as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: "撤销修改" }));
      // confirm returned false → draft stays dirty, name stays "Renamed".
      expect(nameInput.value).toBe("Renamed");
      expect(screen.getByRole("button", { name: "撤销修改" })).toBeDefined();
    } finally {
      window.confirm = originalConfirm;
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
    expect(screen.getByRole("tab", { name: "基本信息" })).toBeDefined();

    rerender(
      <AgentsPage
        {...stableProps}
        agents={[]}
        selectedAgentId=""
      />,
    );
    expect(screen.queryByRole("tab", { name: "基本信息" })).toBeNull();
  });
});
