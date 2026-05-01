import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette, type Command } from "./CommandPalette";

function makeCommands(executeMocks?: Record<string, () => void>): Command[] {
  return [
    {
      id: "view:chat",
      label: "跳到「对话」",
      group: "导航",
      keywords: ["chat", "view"],
      execute: executeMocks?.["view:chat"] ?? (() => {}),
    },
    {
      id: "view:agents",
      label: "跳到「智能体」",
      group: "导航",
      keywords: ["agents"],
      execute: executeMocks?.["view:agents"] ?? (() => {}),
    },
    {
      id: "action:new-conversation",
      label: "新建对话",
      group: "操作",
      keywords: ["chat", "new"],
      execute: executeMocks?.["action:new-conversation"] ?? (() => {}),
    },
  ];
}

describe("CommandPalette", () => {
  test("renders nothing when closed", () => {
    const { container } = render(
      <CommandPalette
        isOpen={false}
        onClose={() => {}}
        commands={makeCommands()}
      />,
    );
    expect(container.querySelector(".cmdk-overlay")).toBeNull();
  });

  test("opens with the search input focused and lists every command", () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={() => {}}
        commands={makeCommands()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    expect(input).toBeDefined();
    // Three commands → three options.
    expect(screen.getAllByRole("option").length).toBe(3);
    // Group headings are rendered above their commands.
    expect(screen.getByText("导航")).toBeDefined();
    expect(screen.getByText("操作")).toBeDefined();
  });

  test("typing in the search filters commands by label and keywords", () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={() => {}}
        commands={makeCommands()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    fireEvent.change(input, { target: { value: "智能体" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(1);
    expect(options[0]!.textContent ?? "").toContain("智能体");
  });

  test("Enter executes the active command and triggers close", async () => {
    const executed: string[] = [];
    const onClose = mock(() => {});
    render(
      <CommandPalette
        isOpen={true}
        onClose={onClose}
        commands={makeCommands({
          "view:chat": () => executed.push("chat"),
        })}
      />,
    );
    // First option is active by default — fire Enter on the sheet.
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    fireEvent.keyDown(input, { key: "Enter" });
    // executeAt is async (awaits cmd.execute), so close fires on the
    // next microtask. Drain the queue before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(executed).toEqual(["chat"]);
    expect(onClose).toHaveBeenCalled();
  });

  test("ArrowDown moves activeDescendant; Enter executes the new active command", async () => {
    const executed: string[] = [];
    render(
      <CommandPalette
        isOpen={true}
        onClose={() => {}}
        commands={makeCommands({
          "view:agents": () => executed.push("agents"),
        })}
      />,
    );
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    await Promise.resolve();
    expect(executed).toEqual(["agents"]);
  });

  test("Escape calls onClose", () => {
    const onClose = mock(() => {});
    render(
      <CommandPalette
        isOpen={true}
        onClose={onClose}
        commands={makeCommands()}
      />,
    );
    const input = screen.getByRole("combobox", { name: "搜索命令" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("clicking a row executes that command", async () => {
    const executed: string[] = [];
    render(
      <CommandPalette
        isOpen={true}
        onClose={() => {}}
        commands={makeCommands({
          "action:new-conversation": () => executed.push("new"),
        })}
      />,
    );
    fireEvent.click(screen.getByRole("option", { name: /新建对话/ }));
    await Promise.resolve();
    await Promise.resolve();
    expect(executed).toEqual(["new"]);
  });
});
