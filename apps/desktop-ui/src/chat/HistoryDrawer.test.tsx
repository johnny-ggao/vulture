import type * as React from "react";
import { describe, expect, test, mock } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HistoryDrawer } from "./HistoryDrawer";
import type { ConversationDto } from "../api/conversations";

const items: ConversationDto[] = [
  {
    id: "c-1",
    agentId: "agent-1",
    title: "Project plan",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  } as ConversationDto,
  {
    id: "c-2",
    agentId: "agent-1",
    title: "Bug review",
    updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  } as ConversationDto,
];

function renderDrawer(onDelete: ((id: string) => void) | undefined) {
  return render(
    <HistoryDrawer
      open
      onClose={() => {}}
      items={items}
      activeId={null}
      onSelect={() => {}}
      onNew={() => {}}
      onDelete={onDelete}
    />,
  );
}

describe("HistoryDrawer", () => {
  test("renders as a labelled modal dialog", () => {
    renderDrawer(undefined);

    const dialog = screen.getByRole("dialog", { name: "历史" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBe("history-drawer-subtitle");
  });

  test("Escape closes the drawer", () => {
    const onClose = mock(() => {});
    render(
      <HistoryDrawer
        open
        onClose={onClose}
        items={items}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("focus enters the drawer and returns to the trigger on close", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开历史";
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = renderDrawer(undefined);

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("搜索历史会话"));
    });

    unmount();
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
    trigger.remove();
  });

  test("Tab focus wraps inside the drawer", async () => {
    renderDrawer(mock(() => {}));
    const search = screen.getByLabelText("搜索历史会话");

    await waitFor(() => {
      expect(document.activeElement).toBe(search);
    });

    const newConversation = screen.getByTitle("新建对话");
    newConversation.focus();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "历史" }), {
      key: "Tab",
      shiftKey: true,
    });

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    expect(document.activeElement).toBe(deleteButtons[deleteButtons.length - 1]);

    deleteButtons[deleteButtons.length - 1]?.focus();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "历史" }), { key: "Tab" });
    expect(document.activeElement).toBe(newConversation);
  });

  test("clicking the overlay closes while clicking the drawer itself does not", () => {
    const onClose = mock(() => {});
    const { container } = render(
      <HistoryDrawer
        open
        onClose={onClose}
        items={items}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("dialog", { name: "历史" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector(".history-drawer-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("header shows context subtitle and conversation count", () => {
    renderDrawer(undefined);

    expect(screen.getByText("按智能体和标题回到最近上下文")).toBeDefined();
    expect(screen.getByLabelText("2 条历史会话")).toBeDefined();
  });

  test("clicking delete invokes onDelete with the row id (parent owns confirmation)", () => {
    const onDelete = mock((_id: string) => {});
    renderDrawer(onDelete);

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(deleteButtons[0]);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]?.[0]).toBe("c-1");
  });

  test("each row's delete button targets that row's id", () => {
    const onDelete = mock((_id: string) => {});
    renderDrawer(onDelete);

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(deleteButtons[1]);

    expect(onDelete.mock.calls[0]?.[0]).toBe("c-2");
  });

  test("does not render delete button when onDelete prop omitted", () => {
    renderDrawer(undefined);
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });
});

describe("HistoryDrawer — agent filter chips", () => {
  // Two agents, three conversations spanning both — guarantees the chip
  // row is visible (it only renders when ≥2 agents have conversations).
  const agents = [
    { id: "agent-1", name: "Local Agent" },
    { id: "agent-2", name: "Research Agent" },
  ];
  const mixed: ConversationDto[] = [
    {
      id: "c-1",
      agentId: "agent-1",
      title: "Project plan",
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    } as ConversationDto,
    {
      id: "c-2",
      agentId: "agent-1",
      title: "Bug review",
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    } as ConversationDto,
    {
      id: "c-3",
      agentId: "agent-2",
      title: "Literature review",
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    } as ConversationDto,
  ];

  function renderMixed(extra?: Partial<React.ComponentProps<typeof HistoryDrawer>>) {
    return render(
      <HistoryDrawer
        open
        onClose={() => {}}
        items={mixed}
        agents={agents}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
        {...extra}
      />,
    );
  }

  test("chip row is hidden when only one agent has conversations", () => {
    render(
      <HistoryDrawer
        open
        onClose={() => {}}
        items={items /* both belong to agent-1 */}
        agents={agents}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.queryByRole("group", { name: /按智能体筛选/ })).toBeNull();
  });

  test("renders 全部 + per-agent chips with conversation counts", () => {
    renderMixed();
    const group = screen.getByRole("group", { name: /按智能体筛选/ });
    expect(group).toBeDefined();
    expect(within(group).getByRole("button", { name: /全部/ })).toBeDefined();
    expect(within(group).getByRole("button", { name: /Local Agent/ })).toBeDefined();
    expect(within(group).getByRole("button", { name: /Research Agent/ })).toBeDefined();
  });

  test("clicking an agent chip pins the list to that agent's conversations", () => {
    renderMixed();
    expect(screen.getByText("Project plan")).toBeDefined();
    expect(screen.getByText("Literature review")).toBeDefined();

    fireEvent.click(filterButton(/Research Agent/));

    expect(screen.queryByText("Project plan")).toBeNull();
    expect(screen.queryByText("Bug review")).toBeNull();
    expect(screen.getByText("Literature review")).toBeDefined();
  });

  test("clicking 全部 clears the active filter", () => {
    renderMixed();
    fireEvent.click(filterButton(/Research Agent/));
    expect(screen.queryByText("Project plan")).toBeNull();

    fireEvent.click(filterButton(/全部/));
    expect(screen.getByText("Project plan")).toBeDefined();
    expect(screen.getByText("Literature review")).toBeDefined();
  });

  test("filter and search compose — pinned agent + matching title only", () => {
    renderMixed();
    fireEvent.click(filterButton(/Local Agent/));
    fireEvent.change(screen.getByPlaceholderText(/搜索历史会话/), {
      target: { value: "project" },
    });
    expect(screen.getByText("Project plan")).toBeDefined();
    expect(screen.queryByText("Bug review")).toBeNull();
    expect(screen.queryByText("Literature review")).toBeNull();
  });

  test("active chip carries aria-pressed=true; others aria-pressed=false", () => {
    renderMixed();
    fireEvent.click(filterButton(/Research Agent/));
    expect(
      filterButton(/Research Agent/).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      filterButton(/全部/).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      filterButton(/Local Agent/).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("auto-clears the filter when the pinned agent has no remaining conversations", () => {
    const { rerender } = renderMixed();
    fireEvent.click(filterButton(/Research Agent/));
    expect(screen.getByText("Literature review")).toBeDefined();

    // Drop agent-2's conversation; the filter should snap back to 全部.
    rerender(
      <HistoryDrawer
        open
        onClose={() => {}}
        items={mixed.filter((c) => c.agentId !== "agent-2")}
        agents={agents}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    // Agent filter chips disappear (only one agent has conversations now).
    expect(screen.queryByRole("group", { name: /按智能体筛选/ })).toBeNull();
    // The remaining conversations are visible.
    expect(screen.getByText("Project plan")).toBeDefined();
    expect(screen.getByText("Bug review")).toBeDefined();
  });

  test("filter resets when the drawer closes and reopens", () => {
    const { rerender } = renderMixed();
    fireEvent.click(filterButton(/Research Agent/));
    expect(
      filterButton(/Research Agent/).getAttribute("aria-pressed"),
    ).toBe("true");

    rerender(
      <HistoryDrawer
        open={false}
        onClose={() => {}}
        items={mixed}
        agents={agents}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    rerender(
      <HistoryDrawer
        open
        onClose={() => {}}
        items={mixed}
        agents={agents}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );

    expect(
      filterButton(/全部/).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

function filterButton(name: RegExp) {
  return within(screen.getByRole("group", { name: /按智能体筛选/ })).getByRole(
    "button",
    { name },
  );
}
