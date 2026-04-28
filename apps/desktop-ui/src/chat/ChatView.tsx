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
        <div className="reconnect-chip">重连中…（{props.runError ?? ""}）</div>
      ) : null}
      {props.sendError ? <div className="send-error">{props.sendError}</div> : null}

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
