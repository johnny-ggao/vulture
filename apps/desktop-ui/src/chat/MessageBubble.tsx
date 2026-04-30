// SAFETY: all message content is rendered via React children (auto-escaped).
// markdown.ts emits a typed AST with link href validated against
// SAFE_HREF_PROTOCOLS. Do NOT introduce dangerouslySetInnerHTML in this file.
import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenUsageDto } from "../api/runs";
import type { MessageAttachmentDto } from "../api/conversations";
import { AgentAvatar } from "./components";
import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "./markdown";

export interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: ReadonlyArray<MessageAttachmentDto>;
  usage?: TokenUsageDto | null;
  /**
   * Optional context about which agent produced an assistant message —
   * used to render a tinted avatar matching the rest of the surface
   * (AgentCard, ChatAgentHeader). Ignored for user / system roles.
   * Falls back to a generic "V" letter avatar when missing.
   */
  agent?: { id: string; name: string };
  /**
   * When true, renders a blinking caret at the end of the rendered content
   * to signal the assistant is still producing tokens. Only honoured for
   * assistant role; user/system messages never display the caret.
   */
  streaming?: boolean;
}

export function MessageBubble({
  role,
  content,
  attachments = [],
  usage,
  agent,
  streaming = false,
}: MessageBubbleProps) {
  const showCaret = streaming && role === "assistant";
  return (
    <article className={`message ${role}`}>
      <MessageAvatar role={role} agent={agent} />
      <div className="message-bubble">
        {role === "assistant" ? (
          <>
            <MarkdownContent source={content} />
            {/* Action rail for the assistant's last-rendered output —
              * copy the full plaintext, useful when the user wants to
              * paste a long answer somewhere else. Hidden while the
              * stream is still in flight to avoid copying half a
              * thought. */}
            {!streaming && content.length > 0 ? (
              <MessageActions content={content} />
            ) : null}
          </>
        ) : (
          // User input: preserve newlines and whitespace via white-space:
          // pre-wrap on the message-bubble class, but render in the regular
          // body font (not monospace) — chat input is conversational, not
          // code, and the old `<pre>` made messages feel like terminal output.
          <div className="message-text">{content}</div>
        )}
        {showCaret ? (
          <span className="streaming-caret" aria-hidden="true" />
        ) : null}
        {attachments.length > 0 ? (
          <div className="message-attachments">
            {attachments.map((attachment) => (
              <a
                key={attachment.id}
                className={`message-attachment message-attachment-${attachment.kind === "image" ? "image" : "file"}`}
                href={attachment.contentUrl}
                title={attachment.displayName}
              >
                <span className="message-attachment-icon" aria-hidden="true">
                  {attachment.kind === "image" ? <ImageIcon /> : <FileIcon />}
                </span>
                <strong className="message-attachment-name">
                  {attachment.displayName}
                </strong>
                <em className="message-attachment-size">
                  {formatBytes(attachment.sizeBytes)}
                </em>
              </a>
            ))}
          </div>
        ) : null}
        {usage ? <TokenUsagePill usage={usage} /> : null}
      </div>
    </article>
  );
}

/**
 * Avatar slot. Assistant uses the per-agent AgentAvatar (square, hue-tinted)
 * when an `agent` prop is threaded through; otherwise we fall back to the
 * legacy "V" letter circle so historical messages without agent context
 * still render reasonably. User messages always show the same "J" circle —
 * we don't have a per-user identity model yet.
 */
function MessageAvatar({
  role,
  agent,
}: {
  role: MessageBubbleProps["role"];
  agent?: { id: string; name: string };
}) {
  if (role === "assistant" && agent) {
    return (
      <div className="message-avatar message-avatar-agent">
        <AgentAvatar agent={agent} size={32} shape="square" />
      </div>
    );
  }
  return (
    <div className="message-avatar">
      {role === "user" ? "J" : "V"}
    </div>
  );
}

/**
 * Tiny action rail that appears under finalised assistant messages.
 * Currently only Copy — the visual scaffolding leaves room for retry /
 * regenerate / star later without restructuring.
 */
function MessageActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable in some contexts (e.g. Tauri without permission).
    }
  }

  return (
    <div className="message-actions">
      <button
        type="button"
        className="message-action"
        aria-label="复制回复"
        data-copied={copied || undefined}
        onClick={copy}
      >
        {copied ? <CheckSmallIcon /> : <CopyIcon />}
        <span>{copied ? "已复制" : "复制"}</span>
      </button>
    </div>
  );
}

/**
 * Token-usage pill rendered at the foot of an assistant bubble. Uses
 * tabular-nums (via CSS) so the digits don't reflow as numbers update on
 * subsequent runs. Hover reveals the breakdown via title attribute.
 */
function TokenUsagePill({ usage }: { usage: TokenUsageDto }) {
  const breakdown = `${usage.inputTokens.toLocaleString("en-US")} in · ${usage.outputTokens.toLocaleString(
    "en-US",
  )} out`;
  return (
    <div
      className="message-usage"
      title={`${breakdown} · ${usage.totalTokens.toLocaleString("en-US")} total`}
    >
      <span className="message-usage-icon" aria-hidden="true">
        <TokenIcon />
      </span>
      <span className="message-usage-value">
        {usage.totalTokens.toLocaleString("en-US")}
      </span>
      <span className="message-usage-label">tokens</span>
    </div>
  );
}

function MarkdownContent({ source }: { source: string }) {
  // Streaming assistant messages re-render every token; memoize so we don't
  // re-tokenize the whole transcript on each chunk append.
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="md-content">
      {blocks.map((block, idx) => renderBlock(block, idx))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, key: number) {
  switch (block.kind) {
    case "code":
      return <CodeBlock key={key} lang={block.lang} text={block.text} />;
    case "heading": {
      const inlines = block.inlines.map((inline, i) => renderInline(inline, i));
      if (block.level === 2) return <h2 key={key} className="md-h md-h2">{inlines}</h2>;
      if (block.level === 3) return <h3 key={key} className="md-h md-h3">{inlines}</h3>;
      return <h4 key={key} className="md-h md-h4">{inlines}</h4>;
    }
    case "list": {
      const items = block.items.map((inlines, i) => (
        <li key={i}>{inlines.map((inline, j) => renderInline(inline, j))}</li>
      ));
      return block.ordered ? (
        <ol key={key} className="md-list">{items}</ol>
      ) : (
        <ul key={key} className="md-list">{items}</ul>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key} className="md-blockquote">
          {block.inlines.map((inline, i) => renderInline(inline, i))}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="md-hr" />;
    case "table": {
      // GFM table — we render alignment via inline text-align so the
      // value carries even when the user copies the table out into
      // another tool. `<colgroup>` would be cleaner but doesn't carry
      // through plain-text copy.
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, c) => (
                  <th
                    key={c}
                    style={{ textAlign: block.align[c] ?? "left" }}
                  >
                    {cell.map((inline, i) => renderInline(inline, i))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      style={{ textAlign: block.align[c] ?? "left" }}
                    >
                      {cell.map((inline, i) => renderInline(inline, i))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "paragraph":
    default:
      return (
        <p key={key}>
          {block.inlines.map((inline, i) => renderInline(inline, i))}
        </p>
      );
  }
}

function renderInline(inline: MarkdownInline, key: number) {
  switch (inline.kind) {
    case "code":
      return <code key={key}>{inline.text}</code>;
    case "link":
      return (
        <a key={key} href={inline.href} target="_blank" rel="noreferrer noopener">
          {inline.text}
        </a>
      );
    case "strong":
      return <strong key={key}>{inline.text}</strong>;
    case "text":
    default:
      return <span key={key}>{inline.text}</span>;
  }
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write may fail in restricted contexts — silently ignore.
    }
  }

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span className="lang">{lang || "text"}</span>
        <button
          type="button"
          className="md-copy-btn"
          aria-label="复制代码"
          data-copied={copied || undefined}
          onClick={copy}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre tabIndex={0} aria-label={lang || "code"}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function ImageIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="M3 12l3-3 2.5 2.5L11 8l2 2" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9 2.5v3h3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="8" height="9" rx="1.5" />
      <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" />
    </svg>
  );
}

function CheckSmallIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

function TokenIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.5v3.5l2 1.5" />
    </svg>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
