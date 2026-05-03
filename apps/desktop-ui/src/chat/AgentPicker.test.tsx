import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentPicker } from "./AgentPicker";

const agents = [
  { id: "a1", name: "Agent One" },
  { id: "a2", name: "Agent Two" },
];

describe("AgentPicker", () => {
  test("trigger label says 切换智能体 and aria-label includes the active agent", () => {
    render(<AgentPicker agents={agents} selectedAgentId="a1" onSelectAgent={() => {}} />);
    const trigger = screen.getByRole("button", { name: /切换智能体/ });
    expect(trigger.textContent).toContain("切换智能体");
    expect(trigger.getAttribute("aria-label")).toContain("Agent One");
  });

  test("clicking the trigger opens a menu listing all agents", () => {
    render(<AgentPicker agents={agents} selectedAgentId="a1" onSelectAgent={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /切换智能体/ }));
    expect(screen.getByRole("menu", { name: /智能体/ })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: /Agent One/ })).toBeDefined();
    expect(screen.getByRole("menuitemradio", { name: /Agent Two/ })).toBeDefined();
  });

  test("selecting an agent calls onSelectAgent and closes the menu", () => {
    const onSelectAgent = mock((_id: string) => {});
    render(<AgentPicker agents={agents} selectedAgentId="a1" onSelectAgent={onSelectAgent} />);
    fireEvent.click(screen.getByRole("button", { name: /切换智能体/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Agent Two/ }));
    expect(onSelectAgent).toHaveBeenCalledWith("a2");
    expect(screen.queryByRole("menu", { name: /智能体/ })).toBeNull();
  });

  test("ArrowDown / ArrowUp / Home / End navigate the menu", () => {
    render(<AgentPicker agents={agents} selectedAgentId="a1" onSelectAgent={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /切换智能体/ }));
    const menu = screen.getByRole("menu", { name: /智能体/ });
    const items = screen.getAllByRole("menuitemradio");
    expect(items[0].getAttribute("tabindex")).toBe("0");
    expect(items[1].getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1].getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(menu, { key: "End" });
    expect(items[items.length - 1].getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0].getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items[items.length - 1].getAttribute("tabindex")).toBe("0");
  });

  test("Escape closes the menu without selecting", () => {
    const onSelectAgent = mock((_id: string) => {});
    render(<AgentPicker agents={agents} selectedAgentId="a1" onSelectAgent={onSelectAgent} />);
    fireEvent.click(screen.getByRole("button", { name: /切换智能体/ }));
    expect(screen.getByRole("menu", { name: /智能体/ })).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: /智能体/ })).toBeNull();
    expect(onSelectAgent).not.toHaveBeenCalled();
  });
});
