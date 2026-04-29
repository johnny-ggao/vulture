import type { ReactNode } from "react";

import type { MessageDto } from "../api/conversations";
import type { ApprovalDecision, TokenUsageDto } from "../api/runs";
import type { RunStreamStatus, AnyRunEvent } from "../hooks/useRunStream";
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

  return (
    <main className="chat-main">
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
