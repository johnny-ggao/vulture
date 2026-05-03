import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentsPage, type AgentConfigPatch } from "./AgentsPage";
import type { Agent, AgentCoreFilesResponse } from "../api/agents";
import { localAgentFixture as baseAgent } from "./__fixtures__/agent";
import type { AgentsTab } from "./AgentEditModal";

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
    expect(screen.queryByRole("tab", { name: "身份" })).toBeNull();
    openEditModal();
    expect(screen.getByRole("tab", { name: "身份" })).toBeDefined();
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
  test("modal exposes 身份 / 工具 / 技能 / 协作 / 核心文件 tabs", () => {
    // Round 24: persona moved into the AGENTS.md core file, so the
    // dedicated 人格 rail tab is gone — the persona starter picker
    // now lives inside CoreTab as the 风格 menu.
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.getByRole("tab", { name: "身份" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "工具" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "技能" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "协作" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "核心文件" })).toBeDefined();
    expect(screen.queryByRole("tab", { name: "人格" })).toBeNull();
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

    fireEvent.click(screen.getByRole("tab", { name: "工具" }));
    expect(screen.queryByLabelText("名称")).toBeNull();
  });

  test("preview card is bound to the Identity tab in edit mode", () => {
    // Round 25: the right-hand 智能体预览 only mirrors fields the
    // user is editing on the Identity tab, so it hides on Tools /
    // Skills / 协作 / 核心文件 to give the form back the freed space.
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    expect(screen.getByLabelText("智能体预览")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "工具" }));
    expect(screen.queryByLabelText("智能体预览")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "协作" }));
    expect(screen.queryByLabelText("智能体预览")).toBeNull();

    // Returning to Identity brings it back.
    fireEvent.click(screen.getByRole("tab", { name: "身份" }));
    expect(screen.getByLabelText("智能体预览")).toBeDefined();
  });

  test("preview card follows the same Identity-only rule in create mode", () => {
    // 新建智能体页面和编辑页保持一致 — both modes scope the preview
    // to the Identity tab.
    render(
      <AgentsPage
        {...stableProps}
        agents={[]}
        selectedAgentId=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "创建第一个智能体" }));
    expect(screen.getByLabelText("智能体预览")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    expect(screen.queryByLabelText("智能体预览")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "身份" }));
    expect(screen.getByLabelText("智能体预览")).toBeDefined();
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
    expect(screen.getByRole("tab", { name: "身份" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("tab", { name: "身份" })).toBeNull();
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
    expect(screen.getByRole("tab", { name: "身份" })).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tab", { name: "身份" })).toBeNull();
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
      expect(screen.getByRole("tab", { name: "身份" })).toBeDefined();
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
      expect(screen.queryByRole("tab", { name: "身份" })).toBeNull();
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

  // Round 23: Skills moved to a dedicated rail tab. The mode segmented
  // control flips between 全部可用 / 自定义 / 已禁用; in 自定义 mode
  // chips render one per allowlist entry.

  test("Skills tab opens in 全部可用 mode by default", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    expect(
      (screen.getByRole("radio", { name: "全部可用" }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  test("Skills tab 已禁用 mode persists 'none' through the segmented control", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    fireEvent.click(screen.getByRole("radio", { name: "已禁用" }));
    expect(
      (screen.getByRole("radio", { name: "已禁用" }) as HTMLElement).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  test("Skills tab 自定义 mode adds + removes chip entries", () => {
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.click(screen.getByRole("tab", { name: "技能" }));
    fireEvent.click(screen.getByRole("radio", { name: "自定义" }));
    const input = screen.getByLabelText("添加 Skill") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(
      container.querySelectorAll(".agent-skills-editor-chip").length,
    ).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "移除 alpha" }));
    expect(
      container.querySelectorAll(".agent-skills-editor-chip").length,
    ).toBe(1);
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

  test("modal tabs use the vertical rail layout with role=tab semantics", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    // Round 22: tab rail is vertical (Accio idiom). Tablist still uses
    // role=tablist + role=tab for screen readers, and each item carries
    // the rail-item class.
    const tabs = screen.getAllByRole("tab");
    // Round 24: 5 rail tabs in edit mode (身份/工具/技能/协作/核心文件) —
    // 人格 collapsed into the AGENTS.md core file.
    expect(tabs.length).toBe(5);
    for (const tab of tabs) {
      expect(tab.classList.contains("agent-edit-rail-item")).toBe(true);
    }
    // Tablist exposes vertical orientation for assistive tech.
    const tablist = screen.getByRole("tablist", { name: "智能体配置" });
    expect(tablist.getAttribute("aria-orientation")).toBe("vertical");
  });

  // ---- Round 15: per-tab dirty dot + save error + persona starters

  test("editing the description shows the dirty dot only on the Identity tab", () => {
    const { container } = render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    fireEvent.change(screen.getByLabelText("描述"), {
      target: { value: "new copy" },
    });
    // The Identity tab now carries a dot; the others do not.
    const overviewTab = screen.getByRole("tab", { name: "身份" });
    expect(overviewTab.querySelector(".agent-edit-rail-dot")).not.toBeNull();
    const toolsTab = screen.getByRole("tab", { name: "工具" });
    expect(toolsTab.querySelector(".agent-edit-rail-dot")).toBeNull();
    expect(container.querySelectorAll(".agent-edit-rail-dot").length).toBe(1);
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

  test("create mode shows a 人格风格 seed row that disappears once seeded", () => {
    // Round 24: persona starters moved out of a dedicated tab. In
    // create mode the Identity tab carries a 人格风格 chip row that
    // seeds the AGENTS.md body (passed as draft.instructions on save);
    // once a chip is clicked the row hint flips to "已经选择了风格".
    render(
      <AgentsPage
        {...stableProps}
        agents={[]}
        selectedAgentId=""
      />,
    );
    // Empty-state branch uses "创建第一个智能体" as the create CTA.
    fireEvent.click(screen.getByRole("button", { name: "创建第一个智能体" }));
    expect(screen.getByText(/选择一个起点/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "代码审阅" }));
    expect(screen.queryByText(/选择一个起点/)).toBeNull();
    expect(screen.getByText(/已经选择了风格/)).toBeDefined();
  });

  // (Removed) "workspace block shows a copy button" — T5 of the preset-agents
  // plan replaced the read-only workspace InfoBlock with an editable text
  // input. The copy chip no longer exists; the OverviewTab tests cover the
  // new editable behavior.

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

  test("ArrowDown on the modal tablist moves to the next tab; ArrowUp goes back", () => {
    render(
      <AgentsPage
        {...stableProps}
        agents={[baseAgent]}
        selectedAgentId="agent-1"
      />,
    );
    openEditModal();
    // Initially Overview (身份) is selected.
    expect(
      (
        screen.getByRole("tab", { name: "身份" }) as HTMLElement
      ).getAttribute("aria-selected"),
    ).toBe("true");
    // Round 22: tab rail is vertical (Accio idiom) — Down/Up arrows
    // navigate between tabs; aria-selected should flip to Tools.
    const tablist = screen.getByRole("tablist", { name: "智能体配置" });
    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    expect(
      screen
        .getByRole("tab", { name: "工具" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowUp" });
    expect(
      (
        screen.getByRole("tab", { name: "身份" }) as HTMLElement
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
        screen.getByRole("tab", { name: "身份" }) as HTMLElement
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
    expect(screen.getByRole("tab", { name: "身份" })).toBeDefined();

    rerender(
      <AgentsPage
        {...stableProps}
        agents={[]}
        selectedAgentId=""
      />,
    );
    expect(screen.queryByRole("tab", { name: "身份" })).toBeNull();
  });

  test("AgentsPage opens the modal for the agent in initialEditTarget on mount", () => {
    const codingAgent: Agent = {
      ...baseAgent,
      id: "coding-agent",
      name: "Vulture Coding",
      isPrivateWorkspace: true,
    };
    const target: { agentId: string; tab: AgentsTab } = {
      agentId: "coding-agent",
      tab: "overview",
    };
    render(
      <AgentsPage
        {...stableProps}
        agents={[codingAgent]}
        selectedAgentId="coding-agent"
        initialEditTarget={target}
      />,
    );
    // The modal should be open — the Identity tab is visible.
    expect(screen.getByRole("tab", { name: "身份" })).toBeDefined();
    // And the agent name appears in the modal header.
    expect(screen.getByRole("heading", { name: "Vulture Coding", level: 2 })).toBeDefined();
  });
});
