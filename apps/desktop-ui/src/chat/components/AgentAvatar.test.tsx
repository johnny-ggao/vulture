import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { AgentAvatar } from "./AgentAvatar";

describe("AgentAvatar", () => {
  test("renders the first character of the agent name uppercased", () => {
    const { container } = render(
      <AgentAvatar agent={{ id: "a-1", name: "Local Work Agent" }} />,
    );
    expect(container.textContent).toContain("L");
  });

  test("falls back to a placeholder glyph when name is empty", () => {
    const { container } = render(
      <AgentAvatar agent={{ id: "a-1", name: "" }} />,
    );
    // Avatar still renders something — never an empty box.
    expect(container.querySelector(".agent-avatar")).not.toBeNull();
    expect((container.textContent ?? "").length).toBeGreaterThan(0);
  });

  test("color is deterministic per agent id (same id => same hue)", () => {
    const { container: a1 } = render(
      <AgentAvatar agent={{ id: "agent-x", name: "X" }} />,
    );
    const { container: a2 } = render(
      <AgentAvatar agent={{ id: "agent-x", name: "X" }} />,
    );
    const h1 = a1.querySelector(".agent-avatar")?.getAttribute("data-hue");
    const h2 = a2.querySelector(".agent-avatar")?.getAttribute("data-hue");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^\d+$/);
  });

  test("different agent ids produce different hues most of the time", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const hues = new Set<string>();
    for (const id of ids) {
      const { container } = render(
        <AgentAvatar agent={{ id, name: id.toUpperCase() }} />,
      );
      const h = container.querySelector(".agent-avatar")?.getAttribute("data-hue");
      if (h) hues.add(h);
    }
    // At least 4 unique hues across 8 ids — guards against a hash collapse bug.
    expect(hues.size).toBeGreaterThanOrEqual(4);
  });

  test("size prop controls width / height in px", () => {
    const { container } = render(
      <AgentAvatar agent={{ id: "x", name: "X" }} size={48} />,
    );
    const node = container.querySelector(".agent-avatar") as HTMLElement | null;
    expect(node?.style.width).toBe("48px");
    expect(node?.style.height).toBe("48px");
  });

  test("default size is 32px", () => {
    const { container } = render(
      <AgentAvatar agent={{ id: "x", name: "X" }} />,
    );
    const node = container.querySelector(".agent-avatar") as HTMLElement | null;
    expect(node?.style.width).toBe("32px");
  });

  test("aria-hidden so screen readers read the surrounding name only", () => {
    const { container } = render(
      <AgentAvatar agent={{ id: "x", name: "X" }} />,
    );
    expect(container.querySelector(".agent-avatar")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("supports a square shape variant for cards", () => {
    const { container } = render(
      <AgentAvatar agent={{ id: "x", name: "X" }} shape="square" />,
    );
    expect(container.querySelector(".agent-avatar")?.getAttribute("data-shape")).toBe("square");
  });
});
