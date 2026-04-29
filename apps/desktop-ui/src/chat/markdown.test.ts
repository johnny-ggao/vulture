import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  test("returns a single text-only paragraph for plain content", () => {
    const blocks = parseMarkdown("hello world");
    expect(blocks).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "hello world" }] },
    ]);
  });

  test("splits double newlines into separate paragraphs", () => {
    const blocks = parseMarkdown("first\n\nsecond");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: [{ kind: "text", text: "first" }],
    });
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      inlines: [{ kind: "text", text: "second" }],
    });
  });

  test("extracts a fenced code block with its language", () => {
    const blocks = parseMarkdown("```ts\nconst x = 1;\n```");
    expect(blocks).toEqual([
      { kind: "code", lang: "ts", text: "const x = 1;" },
    ]);
  });

  test("preserves text around a fenced code block", () => {
    const blocks = parseMarkdown("before\n\n```js\nfoo()\n```\n\nafter");
    expect(blocks).toHaveLength(3);
    expect(blocks[0].kind).toBe("paragraph");
    expect(blocks[1]).toEqual({ kind: "code", lang: "js", text: "foo()" });
    expect(blocks[2].kind).toBe("paragraph");
  });

  test("parses inline code with backticks", () => {
    const blocks = parseMarkdown("call `fn()` to start");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: [
        { kind: "text", text: "call " },
        { kind: "code", text: "fn()" },
        { kind: "text", text: " to start" },
      ],
    });
  });

  test("parses [text](url) links", () => {
    const blocks = parseMarkdown("see [the docs](https://example.com) here");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: [
        { kind: "text", text: "see " },
        { kind: "link", text: "the docs", href: "https://example.com" },
        { kind: "text", text: " here" },
      ],
    });
  });

  test("parses **bold**", () => {
    const blocks = parseMarkdown("hi **there**");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: [
        { kind: "text", text: "hi " },
        { kind: "strong", text: "there" },
      ],
    });
  });

  test("rejects javascript: links", () => {
    const blocks = parseMarkdown("[bad](javascript:alert(1))");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: [{ kind: "text", text: "[bad](javascript:alert(1))" }],
    });
  });

  test("rejects protocol-relative URLs (//evil.com)", () => {
    const blocks = parseMarkdown("[bad](//evil.com)");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: [{ kind: "text", text: "[bad](//evil.com)" }],
    });
  });

  test("accepts single-slash root paths (/docs)", () => {
    const blocks = parseMarkdown("[home](/docs)");
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: [{ kind: "link", text: "home", href: "/docs" }],
    });
  });

  test("rejects data: URLs", () => {
    const blocks = parseMarkdown("[bad](data:text/html,<script>x</script>)");
    expect(blocks[0]?.kind).toBe("paragraph");
    if (blocks[0]?.kind === "paragraph") {
      expect(blocks[0].inlines.some((i) => i.kind === "link")).toBe(false);
    }
  });

  test("inline parser does not exhibit catastrophic backtracking on adversarial input", () => {
    // Unbalanced `[` followed by `](` and many trailing chars without a closing `)`
    // — earlier regex-based parser hung for seconds on n=20000.
    const adversarial = "[".repeat(20000) + "x](" + "y".repeat(20000);
    const start = performance.now();
    const blocks = parseMarkdown(adversarial);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("paragraph");
  });

  test("handles unterminated fence by leaving the marker as text", () => {
    const blocks = parseMarkdown("```ts\nstill open");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
  });

  test("preserves leading/trailing whitespace inside paragraphs as a single block", () => {
    const blocks = parseMarkdown("a\nb");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      inlines: [{ kind: "text", text: "a\nb" }],
    });
  });

  test("returns empty array for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});
