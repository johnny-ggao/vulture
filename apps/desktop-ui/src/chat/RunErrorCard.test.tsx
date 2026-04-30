import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { RunErrorCard } from "./RunErrorCard";

describe("RunErrorCard", () => {
  test("renders the failure message with the 运行失败： prefix the run-stream test asserts on", () => {
    render(<RunErrorCard code="internal" message="Connection error." />);
    expect(screen.getByText(/运行失败：Connection error\./)).toBeDefined();
  });

  test("renders the error code as a monospace pill", () => {
    const { container } = render(
      <RunErrorCard code="rate_limited" message="too many requests" />,
    );
    const pill = container.querySelector(".run-error-card-code");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("rate_limited");
  });

  test("uses role=alert so screen readers announce the failure", () => {
    const { container } = render(
      <RunErrorCard code="internal" message="boom" />,
    );
    const card = container.querySelector(".run-error-card");
    expect(card?.getAttribute("role")).toBe("alert");
  });

  test("renders an SVG icon, not an emoji", () => {
    const { container } = render(
      <RunErrorCard code="internal" message="x" />,
    );
    expect(container.querySelector(".run-error-card-icon svg")).not.toBeNull();
    expect(container.textContent ?? "").not.toMatch(/[⚠️🚨❌]/);
  });
});
