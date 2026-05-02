import { useEffect, useState, type ReactNode } from "react";

import type { ConversationPermissionMode, MessageDto } from "../api/conversations";
import type { ApprovalDecision, TokenUsageDto } from "../api/runs";
import type { SubagentSessionDto } from "../api/subagentSessions";
import type { RunStreamStatus, AnyRunEvent } from "../hooks/useRunStream";
import { ChatAgentHeader, isRunningStatus } from "./ChatAgentHeader";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { RunEventStream } from "./RunEventStream";
import { SubagentSessionPanel } from "./SubagentSessionPanel";
import { useStickyBottomScroll } from "./useStickyBottomScroll";
import { BrandMark } from "./components";

export interface ChatViewProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  permissionMode?: ConversationPermissionMode;
  onChangePermissionMode?: (mode: ConversationPermissionMode) => void | Promise<void>;

  messages: ReadonlyArray<MessageDto>;
  messageUsages?: ReadonlyMap<string, TokenUsageDto>;
  subagentSessions?: ReadonlyArray<SubagentSessionDto>;
  subagentMessages?: Readonly<Record<string, ReadonlyArray<MessageDto>>>;
  loadingSubagentMessages?: ReadonlySet<string>;
  onLoadSubagentMessages?: (sessionId: string) => void | Promise<void>;
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
  // Single source of truth lives in ChatAgentHeader so the header pill
  // and the composer's "running" affordance can never drift apart.
  const running = isRunningStatus(props.runStatus, props.resumingRun);

  const hasContent = props.messages.length > 0 || props.runEvents.length > 0;
  const activeAgent = props.agents.find((a) => a.id === props.selectedAgentId)
    ?? props.agents[0]
    ?? null;
  const showAgentHeader = hasContent && activeAgent;

  // Local "dismissed" state for the send-error banner. We can't push
  // back to App.tsx (sendError is owned there for retry semantics), so
  // we hide it locally and reset whenever a NEW error string arrives.
  // This gives the user a clear close affordance without losing the
  // upstream state.
  const [sendErrorDismissed, setSendErrorDismissed] = useState<string | null>(
    null,
  );
  useEffect(() => {
    // Reset dismissal when a fresh error comes in. We compare strings so
    // an identical retry that fails again still re-shows the banner.
    if (props.sendError === null) setSendErrorDismissed(null);
  }, [props.sendError]);
  const showSendError =
    Boolean(props.sendError) && props.sendError !== sendErrorDismissed;

  // Sticky-bottom scroll: while at bottom, every new message / SSE
  // event keeps the view pinned to the latest content; once the user
  // scrolls up to read history, auto-scroll pauses until they hit the
  // 回到底部 button. Deps mirror "things that grow": message count,
  // run event count, run status (so terminal flips force a final
  // snap), and subagent session count.
  const stickyScroll = useStickyBottomScroll<HTMLElement>([
    props.messages.length,
    props.runEvents.length,
    props.runStatus,
    props.subagentSessions?.length ?? 0,
  ]);

  return (
    <main className="chat-main">
      {showAgentHeader ? (
        <ChatAgentHeader
          agent={activeAgent}
          runStatus={props.runStatus}
          resuming={props.resumingRun}
        />
      ) : null}
      {props.runStatus === "reconnecting" ? (
        <div className="status-banner info" role="status" aria-live="polite">
          <span className="status-banner-icon status-banner-icon-spin">
            <ReconnectIcon />
          </span>
          <span><span className="label">重连中…</span>{props.runError ? <span className="detail"> · {props.runError}</span> : null}</span>
        </div>
      ) : null}
      {showSendError ? (
        <div className="status-banner danger" role="alert">
          <span className="status-banner-icon">
            <AlertIcon />
          </span>
          <span className="status-banner-message">{props.sendError}</span>
          <button
            type="button"
            className="status-banner-dismiss"
            aria-label="关闭"
            onClick={() => setSendErrorDismissed(props.sendError ?? null)}
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}

      <section
        ref={stickyScroll.ref as React.RefObject<HTMLElement>}
        className={`chat-stage ${hasContent ? "has-messages" : ""}`}
      >
        {hasContent ? (
          <div className="message-list">
            {props.messages.map((m) => (
              <MessageBubble
                key={m.id}
                role={m.role}
                content={m.content}
                attachments={m.attachments}
                agent={activeAgent ?? undefined}
                usage={m.runId ? props.messageUsages?.get(m.runId) : null}
              />
            ))}
            <RunEventStream
              events={props.runEvents}
              submittingApprovals={props.submittingApprovals}
              resuming={props.resumingRun}
              streaming={props.runStatus === "streaming" || props.runStatus === "connecting"}
              agent={activeAgent ?? undefined}
              onDecide={props.onDecide}
              onResume={props.onResume}
              onCancel={props.onCancel}
            />
            <SubagentSessionPanel
              sessions={props.subagentSessions ?? []}
              messagesBySessionId={props.subagentMessages ?? {}}
              loadingSessionIds={props.loadingSubagentMessages ?? new Set()}
              onLoadMessages={props.onLoadSubagentMessages ?? (async () => {})}
            />
          </div>
        ) : props.onboardingCard ? (
          props.onboardingCard
        ) : (
          <div className="empty-state">
            <div className="hero-mark" aria-hidden="true">
              {/* When an agent is active, drop the brand mark in favour
               * of the agent's first glyph — feels personal, mirrors
               * the kit's "你好，<agent name>" empty hero. Falls back
               * to the vulture brand icon when no agent is selected. */}
              {activeAgent ? firstGlyph(activeAgent.name) : <BrandMark size={64} />}
            </div>
            <h2>
              {activeAgent ? `你好，${activeAgent.name}` : "Vulture"}
            </h2>
            <p>
              {activeAgent
                ? "直接输入任务，或从下面的建议挑一条开始。"
                : "选择智能体，然后直接输入任务。"}
            </p>
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

      {hasContent && !stickyScroll.stuck ? (
        <button
          type="button"
          className="chat-scroll-bottom"
          aria-label="回到底部"
          onClick={stickyScroll.scrollToBottom}
        >
          <ArrowDownIcon />
          <span>回到底部</span>
        </button>
      ) : null}

      <section className="composer-wrap">
        <Composer
          agents={props.agents}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={props.onSelectAgent}
          permissionMode={props.permissionMode}
          onChangePermissionMode={props.onChangePermissionMode}
          running={running}
          onSend={props.onSend}
          onCancel={props.onCancel}
        />
      </section>
    </main>
  );
}

/**
 * Pull the first visible character from an agent's display name to
 * use as the hero glyph. Handles surrogate pairs (emoji), CJK
 * characters, and ASCII uniformly. Returns "·" if the name is empty
 * or whitespace-only, so the hero never collapses to an empty box.
 */
function firstGlyph(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "·";
  // Iterating with for…of yields full code points (surrogate-safe).
  for (const ch of trimmed) return ch;
  return "·";
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

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M4 12l8-8" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3v9.5" />
      <path d="M3.5 8.5L8 13l4.5-4.5" />
    </svg>
  );
}
