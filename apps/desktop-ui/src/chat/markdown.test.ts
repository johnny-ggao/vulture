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

  test("rejects links whose href contains tab/CR/LF whitespace", () => {
    for (const ws of ["\t", "\n", "\r", " "]) {
      const blocks = parseMarkdown(`[bad](https://x${ws}y.com)`);
      expect(blocks[0]?.kind).toBe("paragraph");
      if (blocks[0]?.kind === "paragraph") {
        expect(blocks[0].inlines.some((i) => i.kind === "link")).toBe(false);
      }
    }
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

  // ---- Round 10 extensions: heading / list / blockquote / hr ----

  test("parses ## heading as level 2", () => {
    const blocks = parseMarkdown("## Title\n\nbody");
    expect(blocks[0]).toEqual({
      kind: "heading",
      level: 2,
      inlines: [{ kind: "text", text: "Title" }],
    });
    expect(blocks[1].kind).toBe("paragraph");
  });

  test("parses ### and #### into level 3 / 4", () => {
    const a = parseMarkdown("### sub")[0];
    const b = parseMarkdown("#### sub-sub")[0];
    expect(a).toMatchObject({ kind: "heading", level: 3 });
    expect(b).toMatchObject({ kind: "heading", level: 4 });
  });

  test("does NOT promote # to a heading (level 1 is reserved for the agent header)", () => {
    const blocks = parseMarkdown("# topbar style");
    expect(blocks[0].kind).toBe("paragraph");
  });

  test("parses ##### and beyond as paragraph (out of scope)", () => {
    const blocks = parseMarkdown("##### deep");
    expect(blocks[0].kind).toBe("paragraph");
  });

  test("strips trailing # tokens from heading text", () => {
    const blocks = parseMarkdown("## Title ###");
    expect(blocks[0]).toEqual({
      kind: "heading",
      level: 2,
      inlines: [{ kind: "text", text: "Title" }],
    });
  });

  test("supports inline code / bold / link inside a heading", () => {
    const blocks = parseMarkdown("## Use `bun test` and **note**");
    expect(blocks[0].kind).toBe("heading");
    if (blocks[0].kind === "heading") {
      expect(blocks[0].inlines.some((i) => i.kind === "code")).toBe(true);
      expect(blocks[0].inlines.some((i) => i.kind === "strong")).toBe(true);
    }
  });

  test("parses unordered list with -", () => {
    const blocks = parseMarkdown("- one\n- two");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [{ kind: "text", text: "one" }],
          [{ kind: "text", text: "two" }],
        ],
      },
    ]);
  });

  test("parses unordered list with *", () => {
    const blocks = parseMarkdown("* one\n* two");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false });
    if (blocks[0].kind === "list") expect(blocks[0].items).toHaveLength(2);
  });

  test("parses ordered list with 1. 2. ...", () => {
    const blocks = parseMarkdown("1. first\n2. second");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true });
    if (blocks[0].kind === "list") expect(blocks[0].items).toHaveLength(2);
  });

  test("blank line ends a list and starts a paragraph", () => {
    const blocks = parseMarkdown("- one\n- two\n\nafter");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("list");
    expect(blocks[1].kind).toBe("paragraph");
  });

  test("list items support inline code / bold / link", () => {
    const blocks = parseMarkdown("- run `bun test` to **verify**\n- see [docs](https://example.com)");
    if (blocks[0].kind === "list") {
      const first = blocks[0].items[0];
      expect(first.some((i) => i.kind === "code")).toBe(true);
      expect(first.some((i) => i.kind === "strong")).toBe(true);
      const second = blocks[0].items[1];
      expect(second.some((i) => i.kind === "link")).toBe(true);
    }
  });

  test("parses blockquote", () => {
    const blocks = parseMarkdown("> quoted line\n> and another");
    expect(blocks[0].kind).toBe("blockquote");
    if (blocks[0].kind === "blockquote") {
      // Two source lines join with a single newline; inline parser keeps it
      // as plain text.
      const text = blocks[0].inlines
        .map((i) => (i.kind === "text" ? i.text : ""))
        .join("");
      expect(text).toBe("quoted line\nand another");
    }
  });

  test("parses horizontal rule from --- and ***", () => {
    expect(parseMarkdown("---")[0]).toEqual({ kind: "hr" });
    expect(parseMarkdown("***")[0]).toEqual({ kind: "hr" });
    expect(parseMarkdown("------")[0]).toEqual({ kind: "hr" });
  });

  test("does not treat -- (only two dashes) as hr", () => {
    const blocks = parseMarkdown("--");
    expect(blocks[0].kind).toBe("paragraph");
  });

  // ---- Round 11: GFM tables -------------------------------------

  test("parses a basic 3-column GFM table", () => {
    const blocks = parseMarkdown(
      ["| a | b | c |", "|---|---|---|", "| 1 | 2 | 3 |"].join("\n"),
    );
    expect(blocks[0].kind).toBe("table");
    if (blocks[0].kind === "table") {
      expect(blocks[0].header).toHaveLength(3);
      expect(blocks[0].rows).toHaveLength(1);
      expect(blocks[0].rows[0]).toHaveLength(3);
      expect(blocks[0].align).toEqual(["left", "left", "left"]);
    }
  });

  test("derives column alignment from the separator row colons", () => {
    const blocks = parseMarkdown(
      ["| a | b | c |", "|:---|:---:|---:|", "| 1 | 2 | 3 |"].join("\n"),
    );
    expect(blocks[0].kind).toBe("table");
    if (blocks[0].kind === "table") {
      expect(blocks[0].align).toEqual(["left", "center", "right"]);
    }
  });

  test("supports inline marks (bold / code / link) inside cells", () => {
    const blocks = parseMarkdown(
      [
        "| key | value |",
        "|---|---|",
        "| **id** | `abc` |",
        "| docs | [link](https://example.com) |",
      ].join("\n"),
    );
    expect(blocks[0].kind).toBe("table");
    if (blocks[0].kind === "table") {
      const idCell = blocks[0].rows[0][0];
      expect(idCell.some((i) => i.kind === "strong")).toBe(true);
      const codeCell = blocks[0].rows[0][1];
      expect(codeCell.some((i) => i.kind === "code")).toBe(true);
      const linkCell = blocks[0].rows[1][1];
      expect(linkCell.some((i) => i.kind === "link")).toBe(true);
    }
  });

  test("pads body rows with fewer cells than the header to match column count", () => {
    const blocks = parseMarkdown(
      [
        "| a | b | c |",
        "|---|---|---|",
        "| 1 | 2 |", // missing third cell
      ].join("\n"),
    );
    if (blocks[0].kind === "table") {
      expect(blocks[0].rows[0]).toHaveLength(3);
      expect(blocks[0].rows[0][2]).toEqual([]);
    }
  });

  test("does not match a table when the separator row is malformed", () => {
    const blocks = parseMarkdown(
      ["| a | b |", "| not | a separator |", "| 1 | 2 |"].join("\n"),
    );
    expect(blocks[0].kind).toBe("paragraph");
  });

  test("does not match a table when the header column count differs from separator", () => {
    const blocks = parseMarkdown(
      ["| a | b |", "|---|---|---|", "| 1 | 2 |"].join("\n"),
    );
    expect(blocks[0].kind).toBe("paragraph");
  });

  test("intermixed blocks land in source order", () => {
    const blocks = parseMarkdown(
      "## Plan\n\n1. fetch data\n2. render\n\n> note: skip step 2 if cached\n\n---\n\nAfter the rule.",
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "list",
      "blockquote",
      "hr",
      "paragraph",
    ]);
  });
});
