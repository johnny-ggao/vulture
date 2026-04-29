import type * as React from "react";
import type { Agent } from "../../api/agents";
import { AgentAvatar } from "./AgentAvatar";
import { hashHue } from "./agentHue";

export interface AgentCardProps {
  agent: Agent;
  /** Click anywhere on the card body opens the editor. */
  onOpenEdit: (id: string) => void;
  /** Top-right "打开对话" action — does not bubble to onOpenEdit. */
  onOpenChat: (id: string) => void;
  /** Optional delete affordance shown alongside open-chat. */
  onDelete?: (id: string) => void;
}

/**
 * Browse-mode card for an agent, modelled after Accio's product-style
 * tile: a banner strip, a square-rounded avatar overlapping the banner
 * edge, then name / description / meta. Hover reveals top-right actions.
 *
 * The card is a `<button>` so keyboard users can reach it; nested action
 * buttons stop event propagation so they trigger their own handlers.
 */
export function AgentCard({ agent, onOpenEdit, onOpenChat, onDelete }: AgentCardProps) {
  return (
    <div className="agent-card">
      <button
        type="button"
        className="agent-card-surface"
        aria-label={agent.name || "未命名智能体"}
        onClick={() => onOpenEdit(agent.id)}
      >
        <div
          className="agent-card-banner"
          aria-hidden="true"
          style={
            {
              "--banner-hue": hashHue(agent.id).toString(),
            } as React.CSSProperties
          }
        />
        <div className="agent-card-avatar">
          <AgentAvatar agent={agent} size={56} shape="square" />
        </div>
        <div className="agent-card-body">
          <h3 className="agent-card-name">{agent.name || "未命名智能体"}</h3>
          <p className="agent-card-desc">
            {agent.description || "（无描述）"}
          </p>
          <div className="agent-card-meta">
            <span className="agent-card-model">{agent.model}</span>
            {agent.tools.length > 0 ? (
              <span className="agent-card-meta-sep" aria-hidden="true">·</span>
            ) : null}
            {agent.tools.length > 0 ? (
              <span className="agent-card-tools">{agent.tools.length} 个工具</span>
            ) : null}
          </div>
        </div>
      </button>

      <div className="agent-card-actions">
        <button
          type="button"
          className="agent-card-action"
          aria-label={`打开对话 ${agent.name || "智能体"}`}
          title="打开对话"
          onClick={(event) => {
            event.stopPropagation();
            onOpenChat(agent.id);
          }}
        >
          <ChatIcon />
        </button>
        {onDelete ? (
          <button
            type="button"
            className="agent-card-action danger"
            aria-label={`删除智能体 ${agent.name || "未命名"}`}
            title="删除"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(agent.id);
            }}
          >
            <TrashIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 2z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 4.5v8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-8" />
    </svg>
  );
}

