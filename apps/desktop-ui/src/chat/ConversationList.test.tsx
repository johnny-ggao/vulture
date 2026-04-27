import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConversationList } from "./ConversationList";
import type { ConversationDto } from "../api/conversations";

const items: ConversationDto[] = [
  {
    id: "c-1",
    agentId: "a",
    title: "First",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  },
  {
    id: "c-2",
    agentId: "a",
    title: "Second",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  },
];

describe("ConversationList", () => {
  test("renders titles and marks active", () => {
    render(
      <ConversationList
        items={items}
        activeId="c-2"
        onSelect={() => {}}
        onNew={() => {}}
      />,
    );
    const second = screen.getByText("Second").closest("button")!;
    expect(second.className).toContain("active");
  });

  test("clicking item calls onSelect with id", () => {
    const onSelect = mock(() => {});
    render(
      <ConversationList items={items} activeId={null} onSelect={onSelect} onNew={() => {}} />,
    );
    fireEvent.click(screen.getByText("First"));
    expect(onSelect).toHaveBeenCalledWith("c-1");
  });

  test("+ 新消息 calls onNew", () => {
    const onNew = mock(() => {});
    render(
      <ConversationList items={items} activeId={null} onSelect={() => {}} onNew={onNew} />,
    );
    fireEvent.click(screen.getByText(/新消息/));
    expect(onNew).toHaveBeenCalled();
  });

  test("empty state renders with hint", () => {
    render(
      <ConversationList items={[]} activeId={null} onSelect={() => {}} onNew={() => {}} />,
    );
    expect(screen.getByText(/没有会话/)).toBeDefined();
  });

  test("renders footer slot when provided", () => {
    render(
      <ConversationList
        items={[]}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
        footerSlot={<div data-testid="auth-slot">auth here</div>}
      />,
    );
    expect(screen.getByTestId("auth-slot")).toBeDefined();
  });
});
