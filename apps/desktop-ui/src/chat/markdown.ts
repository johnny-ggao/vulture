/**
 * Minimal, dependency-free markdown parser for assistant messages.
 *
 * Supports: fenced code blocks, inline code, links, **bold**.
 * Anything else falls through as plain text — by design.
 *
 * SAFETY:
 *   - Audited link protocols (see SAFE_HREF_PROTOCOLS): http(s):, mailto:, /,
 *     #. Rejected: javascript:, data:, vbscript:, file:, protocol-relative
 *     `//host` (which browsers treat as same-protocol cross-origin).
 *   - O(n) inline scanning via indexOf — no `[\s\S]*?` regex prefixes that
 *     would cause ReDoS on adversarial input.
 *   - All output is consumed via React children (auto-escaped). Callers must
 *     not introduce dangerouslySetInnerHTML.
 */

export type MarkdownBlock =
  | { kind: "paragraph"; inlines: ReadonlyArray<MarkdownInline> }
  | { kind: "code"; lang: string; text: string };

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "strong"; text: string };

export function parseMarkdown(source: string): MarkdownBlock[] {
  if (!source.trim()) return [];
  const blocks: MarkdownBlock[] = [];
  const lines = source.split("\n");

  let i = 0;
  let buffer: string[] = [];

  function flushParagraph() {
    if (buffer.length === 0) return;
    const text = buffer.join("\n").replace(/^\n+|\n+$/g, "");
    buffer = [];
    if (!text.trim()) return;
    for (const piece of text.split(/\n{2,}/)) {
      if (!piece.trim()) continue;
      blocks.push({ kind: "paragraph", inlines: parseInlines(piece) });
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^```\s*$/.test(lines[j] ?? "")) {
          close = j;
          break;
        }
      }
      if (close === -1) {
        buffer.push(line);
        i += 1;
        continue;
      }
      flushParagraph();
      blocks.push({
        kind: "code",
        lang: (fence[1] ?? "").trim(),
        text: lines.slice(i + 1, close).join("\n"),
      });
      i = close + 1;
      continue;
    }

    buffer.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

// Allow http(s), mailto, fragment, and absolute root paths. The `(?!\/)`
// negative lookahead rejects protocol-relative URLs like `//evil.com`,
// which browsers resolve to a same-protocol cross-origin URL.
const SAFE_HREF_PROTOCOLS = /^(?:https?:|mailto:|#|\/(?!\/))/i;

type InlineMatch =
  | { kind: "code"; consumed: number; payload: MarkdownInline }
  | { kind: "link"; consumed: number; payload: MarkdownInline | null }
  | { kind: "bold"; consumed: number; payload: MarkdownInline };

function parseInlines(input: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const next = findNextDelimiter(input, cursor);
    if (next === -1) {
      out.push({ kind: "text", text: input.slice(cursor) });
      break;
    }

    if (next > cursor) {
      out.push({ kind: "text", text: input.slice(cursor, next) });
    }

    const match = matchAt(input, next);
    if (!match) {
      // Delimiter not part of a valid construct — emit one char and continue.
      out.push({ kind: "text", text: input[next] ?? "" });
      cursor = next + 1;
      continue;
    }

    if (match.payload) {
      out.push(match.payload);
    } else {
      // e.g. unsafe link href — fall back to literal source slice.
      out.push({ kind: "text", text: input.slice(next, next + match.consumed) });
    }
    cursor = next + match.consumed;
  }

  return mergeAdjacentText(out);
}

// Find the earliest occurrence (>= from) of any inline delimiter. O(n) per
// scan; the outer loop advances `from` past every consumed token, giving
// overall linear behaviour even on adversarial inputs.
function findNextDelimiter(input: string, from: number): number {
  let best = -1;
  const c = input.indexOf("`", from);
  const l = input.indexOf("[", from);
  const b = input.indexOf("**", from);
  for (const idx of [c, l, b]) {
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

// Try to recognise a complete inline construct anchored at `at`.
function matchAt(input: string, at: number): InlineMatch | null {
  const ch = input[at];

  // Inline code: `text`
  if (ch === "`") {
    const close = input.indexOf("`", at + 1);
    if (close === -1) return null;
    const text = input.slice(at + 1, close);
    if (text.length === 0 || text.includes("\n")) return null;
    return {
      kind: "code",
      consumed: close - at + 1,
      payload: { kind: "code", text },
    };
  }

  // Bold: **text**
  if (ch === "*" && input[at + 1] === "*") {
    const close = input.indexOf("**", at + 2);
    if (close === -1) return null;
    const text = input.slice(at + 2, close);
    if (text.length === 0 || text.includes("\n") || text.includes("*")) return null;
    return {
      kind: "bold",
      consumed: close - at + 2,
      payload: { kind: "strong", text },
    };
  }

  // Link: [text](href)
  if (ch === "[") {
    const closeBracket = input.indexOf("]", at + 1);
    if (closeBracket === -1) return null;
    if (input[closeBracket + 1] !== "(") return null;
    const closeParen = input.indexOf(")", closeBracket + 2);
    if (closeParen === -1) return null;
    const text = input.slice(at + 1, closeBracket);
    const href = input.slice(closeBracket + 2, closeParen);
    if (
      text.length === 0 ||
      text.includes("\n") ||
      href.length === 0 ||
      /\s/.test(href)
    ) {
      return null;
    }
    const consumed = closeParen - at + 1;
    if (!SAFE_HREF_PROTOCOLS.test(href)) {
      return { kind: "link", consumed, payload: null };
    }
    return {
      kind: "link",
      consumed,
      payload: { kind: "link", text, href },
    };
  }

  return null;
}

function mergeAdjacentText(items: MarkdownInline[]): MarkdownInline[] {
  const merged: MarkdownInline[] = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (item.kind === "text" && prev?.kind === "text") {
      merged[merged.length - 1] = { kind: "text", text: prev.text + item.text };
    } else {
      merged.push(item);
    }
  }
  return merged;
}
