import type { ReactNode } from "react";

import type { MessageDto } from "../api/conversations";
import type { ApprovalDecision } from "../api/runs";
import type { RunStreamStatus, AnyRunEvent } from "../hooks/useRunStream";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { RunEventStream } from "./RunEventStream";

export interface ChatViewProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;

  messages: ReadonlyArray<MessageDto>;
  runEvents: ReadonlyArray<AnyRunEvent>;
  runStatus: RunStreamStatus;
  runError: string | null;

  submittingApprovals: ReadonlySet<string>;
  onSend: (input: string) => void;
  onCancel: () => void;
  onDecide: (callId: string, decision: ApprovalDecision) => void;

  onboardingCard?: ReactNode;
}

export function ChatView(props: ChatViewProps) {
  const running =
    props.runStatus === "connecting" ||
    props.runStatus === "streaming" ||
    props.runStatus === "reconnecting";

  const hasContent = props.messages.length > 0 || props.runEvents.length > 0;

  return (
    <main className="chat-main">
      {props.runStatus === "reconnecting" ? (
        <div className="reconnect-chip">重连中…（{props.runError ?? ""}）</div>
      ) : null}

      <section className={`chat-stage ${hasContent ? "has-messages" : ""}`}>
        {hasContent ? (
          <div className="message-list">
            {props.messages.map((m) => (
              <MessageBubble key={m.id} role={m.role} content={m.content} />
            ))}
            <RunEventStream
              events={props.runEvents}
              submittingApprovals={props.submittingApprovals}
              onDecide={props.onDecide}
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
