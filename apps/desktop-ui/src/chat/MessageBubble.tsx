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
          <pre>{content}</pre>
        )}
        {showCaret ? (
          <span className="streaming-caret" aria-hidden="true" />
        ) : null}
        {attachments.length > 0 ? (
          <div className="message-attachments">
            {attachments.map((attachment) => (
              <a
                key={attachment.id}
                className="message-attachment"
                href={attachment.contentUrl}
                title={attachment.displayName}
              >
                <span>{attachment.kind === "image" ? "IMG" : "FILE"}</span>
                <strong>{attachment.displayName}</strong>
                <em>{formatBytes(attachment.sizeBytes)}</em>
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
