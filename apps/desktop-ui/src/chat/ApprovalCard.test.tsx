import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";

describe("ApprovalCard", () => {
  test("renders tool name and reason", () => {
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="outside workspace"
        submitting={false}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/shell\.exec/)).toBeDefined();
    expect(screen.getByText(/outside workspace/)).toBeDefined();
  });

  test("clicking 允许 calls onDecide('allow')", () => {
    const onDecide = mock(() => {});
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={false}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByText("允许"));
    expect(onDecide).toHaveBeenCalledWith("c1", "allow");
  });

  test("clicking 拒绝 calls onDecide('deny')", () => {
    const onDecide = mock(() => {});
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={false}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByText("拒绝"));
    expect(onDecide).toHaveBeenCalledWith("c1", "deny");
  });

  test("disabled while submitting; both buttons show 处理中…", () => {
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={true}
        onDecide={() => {}}
      />,
    );
    const buttons = screen.getAllByText("处理中…") as HTMLButtonElement[];
    expect(buttons.length).toBe(2);
    for (const b of buttons) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.disabled).toBe(true);
    }
  });

  test("renders an SVG warning icon, not an emoji", () => {
    const { container } = render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={false}
        onDecide={() => {}}
      />,
    );
    expect(container.textContent ?? "").not.toMatch(/⚠️/);
    expect(container.querySelector(".approval-card-header svg")).not.toBeNull();
  });
});
