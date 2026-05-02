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

  test("running state renders an animated spinner alongside the badge", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="running"
      />,
    );
    expect(container.querySelector(".tool-block-spinner")).not.toBeNull();
  });

  test("non-running states do not render a spinner", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="completed"
        output={{ stdout: "ok" }}
      />,
    );
    expect(container.querySelector(".tool-block-spinner")).toBeNull();
  });

  test("header chevron is an SVG, not a unicode triangle", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="planned"
      />,
    );
    expect(container.querySelector(".tool-block-chevron svg")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("▶");
    expect(container.textContent ?? "").not.toContain("▼");
  });

  test("aria-expanded reflects the open state and updates on click", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="completed"
        output={{ stdout: "src/" }}
      />,
    );
    const header = container.querySelector(".tool-block-header") as HTMLButtonElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  test("expanded body uses the new section labels (调用参数 / 返回)", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="completed"
        output={{ stdout: "src/" }}
      />,
    );
    fireEvent.click(container.querySelector(".tool-block-header")!);
    expect(screen.getByText("调用参数")).toBeDefined();
    expect(screen.getByText("返回")).toBeDefined();
  });

  test("each visible section has a copy button labelled 复制", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls"] }}
        status="completed"
        output={{ stdout: "src/" }}
      />,
    );
    fireEvent.click(container.querySelector(".tool-block-header")!);
    const copyButtons = container.querySelectorAll(".tool-block-copy");
    // Two visible sections (调用参数 + 返回) → two copy buttons.
    expect(copyButtons.length).toBe(2);
  });

  test("shell.exec input preview shows the formatted command, not raw JSON", () => {
    render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["ls", "-la"] }}
        status="running"
      />,
    );
    // Expect to find "$ ls -la" somewhere — the shell summarizer prefixes
    // with "$ ". This is a visible regression-guard that the JSON path
    // fallback isn't being used for shell.exec.
    expect(
      Array.from(document.querySelectorAll("body *"))
        .some((el) => el.textContent?.includes("$ ls -la")),
    ).toBe(true);
  });

  test("browser output renders a compact page summary", () => {
    const { container } = render(
      <ToolBlock
        callId="c-browser"
        tool="browser.screenshot"
        input={{ fullPage: false }}
        status="completed"
        output={{
          title: "OpenAI Agents SDK",
          url: "https://openai.github.io/openai-agents-js/",
          tabId: 3,
          image: "data:image/png;base64,very-large-payload",
        }}
      />,
    );

    fireEvent.click(container.querySelector(".tool-block-header")!);

    expect(container.textContent).toContain("OpenAI Agents SDK");
    expect(container.textContent).toContain("https://openai.github.io/openai-agents-js/");
    expect(container.textContent).toContain("tab 3");
    expect(container.textContent).not.toContain("very-large-payload");
  });

  test("formatted output shows stderr block + exit code when present", () => {
    const { container } = render(
      <ToolBlock
        callId="c1"
        tool="shell.exec"
        input={{ argv: ["bad"] }}
        status="completed"
        output={{ stdout: "", stderr: "command not found", exitCode: 127 }}
      />,
    );
    fireEvent.click(container.querySelector(".tool-block-header")!);
    expect(container.textContent ?? "").toContain("[stderr]");
    expect(container.textContent ?? "").toContain("command not found");
    expect(container.textContent ?? "").toContain("[exit 127]");
  });
});
