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

  test("disabled while submitting; both buttons surface a busy state", () => {
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={true}
        onDecide={() => {}}
      />,
    );
    // Submit-state keeps the button width frozen (label fades to opacity 0
    // and a spinner fades in over the same footprint), so the kept-mounted
    // labels are still findable. Verify both 允许 / 拒绝 buttons are
    // disabled and announce aria-busy="true" for SR users.
    const allow = screen
      .getAllByRole("button", { name: /允许/ })
      .find((b) => b.classList.contains("approval-card-allow")) as HTMLButtonElement | undefined;
    const deny = screen
      .getAllByRole("button", { name: /拒绝/ })
      .find((b) => b.classList.contains("approval-card-deny")) as HTMLButtonElement | undefined;
    expect(allow).toBeDefined();
    expect(deny).toBeDefined();
    for (const b of [allow!, deny!]) {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("aria-busy")).toBe("true");
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

  test("renders a tool input preview when input is provided", () => {
    const { container } = render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="outside workspace"
        input={{ argv: ["rm", "-rf", "/tmp/scratch"] }}
        submitting={false}
        onDecide={() => {}}
      />,
    );
    const preview = container.querySelector(".approval-card-preview");
    expect(preview).not.toBeNull();
    // The shell.exec summarizer joins argv with shell-quoting; the body
    // should contain a recognisable command.
    expect(preview?.textContent ?? "").toContain("rm");
    expect(preview?.textContent ?? "").toContain("/tmp/scratch");
  });

  test("does not render preview when input is omitted", () => {
    const { container } = render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={false}
        onDecide={() => {}}
      />,
    );
    expect(container.querySelector(".approval-card-preview")).toBeNull();
  });

  test("renders a 高风险 chip for shell.exec asks", () => {
    render(
      <ApprovalCard
        callId="c1"
        tool="shell.exec"
        reason="r"
        submitting={false}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText("高风险")).toBeDefined();
  });

  test("does not render any risk chip for plain low-risk tools", () => {
    const { container } = render(
      <ApprovalCard
        callId="c1"
        tool="custom.lookup"
        reason="r"
        submitting={false}
        onDecide={() => {}}
      />,
    );
    expect(container.querySelector(".approval-card-risk")).toBeNull();
  });

  test("Enter key activates Allow when not submitting", () => {
    const onDecide = mock(() => {});
    render(
      <ApprovalCard
        callId="c1"
        tool="custom"
        reason="r"
        submitting={false}
        onDecide={onDecide}
      />,
    );
    // Window-level handler — dispatch on document to mimic a user keystroke
    // landing anywhere in the chat surface (the composer might still be
    // focused, etc.).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onDecide).toHaveBeenCalledWith("c1", "allow");
  });

  test("Escape key activates Deny when not submitting", () => {
    const onDecide = mock(() => {});
    render(
      <ApprovalCard
        callId="c1"
        tool="custom"
        reason="r"
        submitting={false}
        onDecide={onDecide}
      />,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDecide).toHaveBeenCalledWith("c1", "deny");
  });

  test("Enter key is ignored while submitting", () => {
    const onDecide = mock(() => {});
    render(
      <ApprovalCard
        callId="c1"
        tool="custom"
        reason="r"
        submitting={true}
        onDecide={onDecide}
      />,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onDecide).not.toHaveBeenCalled();
  });
});
