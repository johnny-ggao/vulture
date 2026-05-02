import type * as React from "react";
import type { Agent } from "../../api/agents";
import { AgentAvatar } from "./AgentAvatar";
import { hashHue } from "./agentHue";
import { useCursorGloss } from "./useCursorGloss";

export interface AgentCardProps {
  agent: Agent;
  /** Click anywhere on the card body opens the editor. */
  onOpenEdit: (id: string) => void;
  /** "打开对话" action — does not bubble to onOpenEdit. */
  onOpenChat: (id: string) => void;
  /** Optional delete affordance, hover-revealed alongside the action bar. */
  onDelete?: (id: string) => void;
}

/**
 * Browse-mode card for an agent — Accio product-tile language:
 *
 *   - banner with per-agent hue at the top, floating avatar punching
 *     through the banner edge.
 *   - centred name + description below the avatar.
 *   - always-visible "打开对话" pill at the bottom of the card so
 *     the primary action is reachable without hovering or hunting.
 *   - delete affordance (when provided) tucks into the top-right and
 *     reveals on hover only — destructive actions shouldn't shout.
 *   - clicking anywhere outside the action pill opens the editor.
 *
 * Reduced info density: model + tool / skill counts are intentionally
 * not shown on the card. Browsing should be about *which agent* to
 * pick, not its config — config lives in the editor that opens on
 * click.
 */
export function AgentCard({ agent, onOpenEdit, onOpenChat, onDelete }: AgentCardProps) {
  const { ref, ...gloss } = useCursorGloss<HTMLDivElement>();

  return (
    <div className="agent-card" ref={ref} {...gloss}>
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
          <AgentAvatar agent={agent} size={44} shape="square" />
        </div>
        <div className="agent-card-body">
          <h3 className="agent-card-name">{agent.name || "未命名智能体"}</h3>
          <p
            className={
              "agent-card-desc" + (agent.description ? "" : " agent-card-desc-empty")
            }
          >
            {agent.description || "添加一段描述，告诉团队它适合做什么"}
          </p>
        </div>
      </button>

      <div className="agent-card-foot">
        <button
          type="button"
          className="agent-card-cta"
          aria-label={`打开对话 ${agent.name || "智能体"}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenChat(agent.id);
          }}
        >
          <ChatIcon />
          <span>打开对话</span>
        </button>
      </div>

      {onDelete ? (
        <div className="agent-card-actions" aria-label="智能体快捷操作">
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
        </div>
      ) : null}
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

