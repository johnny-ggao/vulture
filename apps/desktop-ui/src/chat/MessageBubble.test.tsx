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
});
