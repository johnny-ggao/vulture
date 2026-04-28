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

  test("renders token usage metadata", () => {
    render(
      <MessageBubble
        role="assistant"
        content="hi"
        usage={{ inputTokens: 1234, outputTokens: 56, totalTokens: 1290 }}
      />,
    );

    expect(screen.getByText("Tokens: 1,234 in · 56 out · 1,290 total")).toBeDefined();
  });
});
