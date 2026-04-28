import type { TokenUsageDto } from "../api/runs";
import type { MessageAttachmentDto } from "../api/conversations";

export interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: ReadonlyArray<MessageAttachmentDto>;
  usage?: TokenUsageDto | null;
}

export function MessageBubble({ role, content, attachments = [], usage }: MessageBubbleProps) {
  const avatar = role === "user" ? "J" : "V";
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar">{avatar}</div>
      <div className="message-bubble">
        <pre>{content}</pre>
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
