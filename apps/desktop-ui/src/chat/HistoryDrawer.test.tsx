import { describe, expect, test, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
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
