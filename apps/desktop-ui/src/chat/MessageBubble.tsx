import type { TokenUsageDto } from "../api/runs";

export interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
  usage?: TokenUsageDto | null;
}

export function MessageBubble({ role, content, usage }: MessageBubbleProps) {
  const avatar = role === "user" ? "J" : "V";
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar">{avatar}</div>
      <div className="message-bubble">
        <pre>{content}</pre>
        {usage ? <div className="message-meta">{formatUsage(usage)}</div> : null}
      </div>
    </article>
  );
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
