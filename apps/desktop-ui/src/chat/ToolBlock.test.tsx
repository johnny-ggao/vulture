import { describe, expect, test } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolBlock } from "./ToolBlock";

describe("ToolBlock", () => {
  test("running state renders expanded with input", () => {
    render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="running"
      />,
    );
    expect(screen.getByText("shell.exec")).toBeDefined();
    // The argv "ls" appears twice: once in the inputSummary in the header,
    // once in the JSON body (running auto-expands per Q5 spec).
    expect(screen.getAllByText(/ls/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("运行中")).toBeDefined();
  });

  test("completed (success) renders collapsed by default", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="completed"
        output={{ stdout: "src/" }}
      />,
    );
    // collapsed = no output visible until clicked
    expect(container.textContent).not.toContain("src/");
  });

  test("clicking title toggles expansion", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="completed"
        output={{ stdout: "src/" }}
      />,
    );
    const header = container.querySelector(".tool-block-header")!;
    fireEvent.click(header);
    expect(container.textContent).toContain("src/");
  });

  test("failed state renders expanded with error", () => {
    render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["x"] }}
        status="failed"
        error={{ code: "tool.execution_failed", message: "boom" }}
      />,
    );
    expect(screen.getByText(/boom/)).toBeDefined();
  });
});
