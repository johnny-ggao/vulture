import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble", () => {
  test("renders attachment names under message content", () => {
    render(
      <MessageBubble
        role="user"
        content="see attached"
        attachments={[
          {
            id: "att-1",
            blobId: "blob-1",
            kind: "file",
            displayName: "note.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            contentUrl: "/v1/attachments/att-1/content",
            createdAt: "2026-04-28T00:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText("note.txt")).toBeDefined();
    expect(screen.getByText("5 B")).toBeDefined();
  });

  test("user messages render content as plain text (no markdown parsing)", () => {
    const { container } = render(
      <MessageBubble role="user" content="run `bun test`" />,
    );
    // The literal backticks should still appear in user input — we don't parse user text.
    expect(container.textContent ?? "").toContain("run `bun test`");
    expect(container.querySelector(".md-content")).toBeNull();
  });

  test("assistant messages render markdown into a md-content block", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="Hello **world**" />,
    );
    const md = container.querySelector(".md-content");
    expect(md).not.toBeNull();
    expect(container.querySelector(".md-content strong")?.textContent).toBe("world");
  });

  test("assistant messages render fenced code blocks with a copy button", () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={"Try:\n\n```ts\nconst x = 1;\n```\n\nDone."}
      />,
    );
    const codeBlock = container.querySelector(".md-codeblock");
    expect(codeBlock).not.toBeNull();
    expect(container.querySelector(".md-codeblock pre code")?.textContent).toBe(
      "const x = 1;",
    );
    expect(container.querySelector(".md-codeblock .lang")?.textContent).toBe("ts");
    expect(container.querySelector('.md-copy-btn[aria-label="复制代码"]')).not.toBeNull();
  });

  test("assistant messages render inline code", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="call `fn()` to start" />,
    );
    const inline = container.querySelector(".md-content code");
    expect(inline?.textContent).toBe("fn()");
  });

  test("assistant messages render safe links as anchors", () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content="see [docs](https://example.com)"
      />,
    );
    const a = container.querySelector(".md-content a") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.textContent).toBe("docs");
  });

  test("assistant messages do NOT create anchors for javascript: links", () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content="[bad](javascript:alert(1))"
      />,
    );
    expect(container.querySelector(".md-content a")).toBeNull();
    expect(container.textContent ?? "").toContain("[bad](javascript:alert(1))");
  });

  test("renders a streaming caret only when streaming=true on assistant role", () => {
    const { container, rerender } = render(
      <MessageBubble role="assistant" content="hello" streaming />,
    );
    expect(container.querySelector(".streaming-caret")).not.toBeNull();

    rerender(<MessageBubble role="assistant" content="hello" />);
    expect(container.querySelector(".streaming-caret")).toBeNull();
  });

  test("never renders a streaming caret on user messages even when streaming=true", () => {
    const { container } = render(
      <MessageBubble role="user" content="hi" streaming />,
    );
    expect(container.querySelector(".streaming-caret")).toBeNull();
  });

  test("streaming caret carries aria-hidden so screen readers ignore it", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="hello" streaming />,
    );
    const caret = container.querySelector(".streaming-caret");
    expect(caret?.getAttribute("aria-hidden")).toBe("true");
  });

  // ---- Round 10: agent avatar, copy-message, usage pill, markdown blocks

  test("assistant bubble uses AgentAvatar when agent prop is provided", () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content="hi"
        agent={{ id: "agent-1", name: "Robin" }}
      />,
    );
    expect(container.querySelector(".message-avatar-agent")).not.toBeNull();
    // The legacy "V" letter no longer renders when an agent is supplied.
    expect(container.querySelector(".message-avatar")?.textContent).not.toBe("V");
  });

  test("assistant bubble falls back to V letter when agent is omitted", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="hi" />,
    );
    const av = container.querySelector(".message-avatar");
    expect(av?.textContent).toBe("V");
    expect(container.querySelector(".message-avatar-agent")).toBeNull();
  });

  test("finalised assistant bubble renders a copy action; user bubble does not", () => {
    const { container, rerender } = render(
      <MessageBubble role="assistant" content="hello there" />,
    );
    const action = container.querySelector(".message-action");
    expect(action).not.toBeNull();
    expect(action?.getAttribute("aria-label")).toBe("复制回复");

    rerender(<MessageBubble role="user" content="hi" />);
    expect(container.querySelector(".message-action")).toBeNull();
  });

  test("streaming assistant bubble hides the copy action (don't copy half a thought)", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="streaming…" streaming />,
    );
    expect(container.querySelector(".message-action")).toBeNull();
  });

  test("token usage renders as a pill with total + breakdown title", () => {
    const { container } = render(
      <MessageBubble
        role="assistant"
        content="answer"
        usage={{ inputTokens: 42, outputTokens: 10, totalTokens: 52 }}
      />,
    );
    const pill = container.querySelector(".message-usage") as HTMLElement | null;
    expect(pill).not.toBeNull();
    // Total number is the visible headline.
    expect(pill?.textContent ?? "").toContain("52");
    // The hover title carries the in/out breakdown.
    const title = pill?.getAttribute("title") ?? "";
    expect(title).toContain("42 in");
    expect(title).toContain("10 out");
  });

  test("markdown headings render as <h2> / <h3> / <h4> with the md-h class", () => {
    // Pass via JS expression so the literal \n escapes are interpreted as
    // newlines (JSX attribute string literals don't process escapes).
    const { container } = render(
      <MessageBubble
        role="assistant"
        content={"## Title\n\n### Subtitle\n\n#### Hint"}
      />,
    );
    const h2 = container.querySelector("h2");
    const h3 = container.querySelector("h3");
    const h4 = container.querySelector("h4");
    expect(h2).not.toBeNull();
    expect(h3).not.toBeNull();
    expect(h4).not.toBeNull();
    expect(h2?.classList.contains("md-h")).toBe(true);
    expect(h3?.classList.contains("md-h")).toBe(true);
    expect(h4?.classList.contains("md-h")).toBe(true);
  });

  test("markdown unordered list renders as <ul> with one <li> per item", () => {
    const { container } = render(
      <MessageBubble role="assistant" content={"- one\n- two\n- three"} />,
    );
    const ul = container.querySelector("ul");
    expect(ul).not.toBeNull();
    expect(ul?.classList.contains("md-list")).toBe(true);
    expect(ul?.querySelectorAll("li").length).toBe(3);
  });

  test("markdown ordered list renders as <ol class=md-list>", () => {
    const { container } = render(
      <MessageBubble role="assistant" content={"1. first\n2. second"} />,
    );
    const ol = container.querySelector("ol");
    expect(ol).not.toBeNull();
    expect(ol?.classList.contains("md-list")).toBe(true);
  });

  test("markdown blockquote renders as <blockquote class=md-blockquote>", () => {
    const { container } = render(
      <MessageBubble role="assistant" content="> quoted line" />,
    );
    const bq = container.querySelector("blockquote");
    expect(bq).not.toBeNull();
    expect(bq?.classList.contains("md-blockquote")).toBe(true);
  });

  test("markdown horizontal rule renders as <hr class=md-hr>", () => {
    const { container } = render(
      <MessageBubble role="assistant" content={"before\n\n---\n\nafter"} />,
    );
    const hr = container.querySelector("hr");
    expect(hr).not.toBeNull();
    expect(hr?.classList.contains("md-hr")).toBe(true);
  });
});
