import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble", () => {
  test("renders user role with content", () => {
    render(<MessageBubble role="user" content="hello world" />);
    expect(screen.getByText("hello world")).toBeDefined();
  });

  test("applies role class for assistant", () => {
    const { container } = render(<MessageBubble role="assistant" content="hi" />);
    const article = container.querySelector("article")!;
    expect(article.className).toContain("assistant");
  });

  test("renders system role with system class", () => {
    const { container } = render(<MessageBubble role="system" content="info" />);
    expect(container.querySelector("article")!.className).toContain("system");
  });
});
