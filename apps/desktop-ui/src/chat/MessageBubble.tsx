export interface MessageBubbleProps {
  role: "user" | "assistant" | "system";
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const avatar = role === "user" ? "J" : "V";
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar">{avatar}</div>
      <div className="message-bubble">
        <pre>{content}</pre>
      </div>
    </article>
  );
}
