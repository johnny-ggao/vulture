import * as React from "react";
import { useRef, type ReactNode } from "react";

import type { MessageDto } from "../api/conversations";
import type { ApprovalDecision, TokenUsageDto } from "../api/runs";
import type { RunStreamStatus, AnyRunEvent } from "../hooks/useRunStream";
import { AgentAvatar } from "./components";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { RunEventStream } from "./RunEventStream";

export interface ChatViewProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;

  messages: ReadonlyArray<MessageDto>;
  messageUsages?: ReadonlyMap<string, TokenUsageDto>;
  runEvents: ReadonlyArray<AnyRunEvent>;
  runStatus: RunStreamStatus;
  runError: string | null;
  sendError?: string | null;

  submittingApprovals: ReadonlySet<string>;
  resumingRun: boolean;
  /**
   * Optional list of starter prompts shown as clickable chips on the empty
   * state. Click sends the chip text as the next user message.
   */
  suggestions?: ReadonlyArray<string>;
  onSend: (input: string, files: File[]) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  onResume: () => void;
  onDecide: (callId: string, decision: ApprovalDecision) => void;

  onboardingCard?: ReactNode;
}

export function ChatView(props: ChatViewProps) {
  const running =
    props.resumingRun ||
    props.runStatus === "connecting" ||
    props.runStatus === "streaming" ||
    props.runStatus === "reconnecting" ||
    props.runStatus === "recoverable";

  const hasContent = props.messages.length > 0 || props.runEvents.length > 0;
  const activeAgent = props.agents.find((a) => a.id === props.selectedAgentId)
    ?? props.agents[0]
    ?? null;
  const showAgentHeader = hasContent && activeAgent;
  const statusLabel = runStatusLabel(props.runStatus, props.resumingRun);

  // Mirror the AgentCard cursor-tracked spotlight on the chat header so the
  // identity strip feels alive, not just a static label. Direct DOM
  // mutation through a ref keeps mousemove cheap (no React re-render); the
  // bounding rect is cached on enter and invalidated on leave.
  const headerRef = useRef<HTMLDivElement | null>(null);
  const headerRectRef = useRef<DOMRect | null>(null);
  function handleHeaderEnter() {
    headerRectRef.current = headerRef.current?.getBoundingClientRect() ?? null;
  }
  function handleHeaderMove(event: React.MouseEvent<HTMLDivElement>) {
    const node = headerRef.current;
    const rect = headerRectRef.current;
    if (!node || !rect) return;
    const x = ((event.clientX - rect.left) / rect.width).toFixed(3);
    const y = ((event.clientY - rect.top) / rect.height).toFixed(3);
    node.style.setProperty("--mouse-x", x);
    node.style.setProperty("--mouse-y", y);
  }
  function handleHeaderLeave() {
    headerRectRef.current = null;
  }

  return (
    <main className="chat-main">
      {showAgentHeader ? (
        <div
          className="chat-agent-header"
          ref={headerRef}
          onMouseEnter={handleHeaderEnter}
          onMouseMove={handleHeaderMove}
          onMouseLeave={handleHeaderLeave}
        >
          <AgentAvatar agent={activeAgent} size={28} shape="square" />
          <div className="chat-agent-meta">
            <span className="chat-agent-name">{activeAgent.name}</span>
            {running ? (
              <span className="chat-agent-status" aria-live="polite">
                <span className="chat-agent-status-dot" aria-hidden="true" />
                {statusLabel}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {props.runStatus === "reconnecting" ? (
        <div className="status-banner info" role="status" aria-live="polite">
          <ReconnectIcon />
          <span><span className="label">重连中…</span>{props.runError ? <span className="detail"> · {props.runError}</span> : null}</span>
        </div>
      ) : null}
      {props.sendError ? (
        <div className="status-banner danger" role="alert">
          <AlertIcon />
          <span>{props.sendError}</span>
        </div>
      ) : null}

      <section className={`chat-stage ${hasContent ? "has-messages" : ""}`}>
        {hasContent ? (
          <div className="message-list">
            {props.messages.map((m) => (
              <MessageBubble
                key={m.id}
                role={m.role}
                content={m.content}
                attachments={m.attachments}
                usage={m.runId ? props.messageUsages?.get(m.runId) : null}
              />
            ))}
            <RunEventStream
              events={props.runEvents}
              submittingApprovals={props.submittingApprovals}
              resuming={props.resumingRun}
              streaming={props.runStatus === "streaming" || props.runStatus === "connecting"}
              onDecide={props.onDecide}
              onResume={props.onResume}
              onCancel={props.onCancel}
            />
          </div>
        ) : props.onboardingCard ? (
          props.onboardingCard
        ) : (
          <div className="empty-state">
            <div className="hero-mark">V</div>
            <h2>Vulture</h2>
            <p>选择智能体，然后直接输入任务。</p>
            {props.suggestions && props.suggestions.length > 0 ? (
              <ul className="suggestion-chips" aria-label="建议提问">
                {props.suggestions.map((text) => (
                  <li key={text}>
                    <button
                      type="button"
                      className="suggestion-chip"
                      onClick={() => {
                        void props.onSend(text, []);
                      }}
                    >
                      {text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <section className="composer-wrap">
        <Composer
          agents={props.agents}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={props.onSelectAgent}
          running={running}
          onSend={props.onSend}
          onCancel={props.onCancel}
        />
      </section>
    </main>
  );
}

/**
 * Map a `RunStreamStatus` to a Chinese label for the chat header status
 * pill. Exhaustive over the union — adding a new status will surface a
 * TypeScript error at the `_exhaustive` line so we don't silently fall
 * through to "处理中".
 */
function runStatusLabel(
  status: RunStreamStatus,
  resuming: boolean,
): string {
  if (resuming) return "恢复中";
  switch (status) {
    case "streaming":    return "回应中";
    case "reconnecting": return "重连中";
    case "recoverable":  return "等待恢复";
    case "connecting":   return "连接中";
    // Terminal / quiescent states never display the indicator (the call
    // site gates on `running`), but listing them here makes the switch
    // exhaustive: a new RunStreamStatus value would fail to compile.
    case "idle":
    case "succeeded":
    case "failed":
    case "cancelled":
      return "处理中";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function ReconnectIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 8a5.5 5.5 0 0 1 9.5-3.8" />
      <path d="M13.5 2.5v3h-3" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.5 3.8" />
      <path d="M2.5 13.5v-3h3" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" />
    </svg>
  );
}
