import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { ThinkingIndicator } from "./ThinkingIndicator";

describe("ThinkingIndicator", () => {
  test("renders 3 pulsing dots and a reduced-motion fallback word", () => {
    const { container } = render(<ThinkingIndicator />);
    const dots = container.querySelectorAll(".thinking-dots span");
    expect(dots.length).toBe(3);
    expect(container.querySelector(".thinking-fallback")).not.toBeNull();
  });

  test("uses an aria-live=polite region so screen readers announce 'thinking'", () => {
    const { container } = render(<ThinkingIndicator />);
    const root = container.querySelector(".message-thinking");
    expect(root?.getAttribute("aria-live")).toBe("polite");
    expect(root?.getAttribute("aria-label")).toBe("智能体正在思考");
  });

  test("uses AgentAvatar when an agent is provided", () => {
    const { container } = render(
      <ThinkingIndicator agent={{ id: "robin", name: "Robin" }} />,
    );
    expect(container.querySelector(".message-avatar-agent")).not.toBeNull();
  });

  test("falls back to V letter avatar when no agent is provided", () => {
    const { container } = render(<ThinkingIndicator />);
    const av = container.querySelector(".message-avatar");
    expect(av?.textContent).toBe("V");
    expect(container.querySelector(".message-avatar-agent")).toBeNull();
  });
});
