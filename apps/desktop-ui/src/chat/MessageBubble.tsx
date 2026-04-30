// SAFETY: all message content is rendered via React children (auto-escaped).
// markdown.ts emits a typed AST with link href validated against
// SAFE_HREF_PROTOCOLS. Do NOT introduce dangerouslySetInnerHTML in this file.
import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenUsageDto } from "../api/runs";
import type { MessageAttachmentDto } from "../api/conversations";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "./markdown";

export interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: ReadonlyArray<MessageAttachmentDto>;
  usage?: TokenUsageDto | null;
  /**
   * When true, renders a blinking caret at the end of the rendered content
   * to signal the assistant is still producing tokens. Only honoured for
   * assistant role; user/system messages never display the caret.
   */
  streaming?: boolean;
}

export function MessageBubble({ role, content, attachments = [], usage, streaming = false }: MessageBubbleProps) {
  const avatar = role === "user" ? "J" : "V";
  const showCaret = streaming && role === "assistant";
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar">{avatar}</div>
      <div className="message-bubble">
        {role === "assistant" ? (
          <MarkdownContent source={content} />
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
        {usage ? <div className="message-meta">{formatUsage(usage)}</div> : null}
      </div>
    </article>
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
  if (block.kind === "code") {
    return <CodeBlock key={key} lang={block.lang} text={block.text} />;
  }
  return (
    <p key={key}>
      {block.inlines.map((inline, i) => renderInline(inline, i))}
    </p>
  );
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

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUsage(usage: TokenUsageDto): string {
  return [
    "Tokens:",
    `${usage.inputTokens.toLocaleString("en-US")} in`,
    "·",
    `${usage.outputTokens.toLocaleString("en-US")} out`,
    "·",
    `${usage.totalTokens.toLocaleString("en-US")} total`,
  ].join(" ");
}
