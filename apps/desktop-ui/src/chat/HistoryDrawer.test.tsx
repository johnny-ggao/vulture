import { describe, expect, test, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { HistoryDrawer } from "./HistoryDrawer";
import type { ConversationDto } from "../api/conversations";

const items: ConversationDto[] = [
  {
    id: "c-1",
    title: "Project plan",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  } as ConversationDto,
  {
    id: "c-2",
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
  test("first delete click does NOT immediately invoke onDelete", () => {
    const onDelete = mock((_id: string) => {});
    renderDrawer(onDelete);

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(deleteButtons[0]);

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDefined();
    expect(screen.getByRole("button", { name: "取消删除" })).toBeDefined();
  });

  test("confirm click invokes onDelete with the row id", () => {
    const onDelete = mock((_id: string) => {});
    renderDrawer(onDelete);

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]?.[0]).toBe("c-1");
  });

  test("cancel click clears pending state without invoking onDelete", () => {
    const onDelete = mock((_id: string) => {});
    renderDrawer(onDelete);

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "取消删除" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  });

  test("clicking another row's delete cancels prior pending state", () => {
    const onDelete = mock((_id: string) => {});
    renderDrawer(onDelete);

    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(deleteButtons[1]);

    // Only one confirm button should be visible at a time
    expect(screen.getAllByRole("button", { name: "确认删除" }).length).toBe(1);
  });

  test("does not render delete button when onDelete prop omitted", () => {
    renderDrawer(undefined);
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  test("Escape clears pending delete state", () => {
    const onDelete = mock((_id: string) => {});
    renderDrawer(onDelete);

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  });

  test("closing the drawer clears pending delete state", () => {
    const onDelete = mock((_id: string) => {});
    const { rerender } = render(
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

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(screen.getByRole("button", { name: "确认删除" })).toBeDefined();

    rerender(
      <HistoryDrawer
        open={false}
        onClose={() => {}}
        items={items}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={onDelete}
      />,
    );
    rerender(
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

    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
  });
});
