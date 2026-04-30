import type * as React from "react";
import type { Agent } from "../../api/agents";
import { AgentAvatar } from "./AgentAvatar";
import { hashHue } from "./agentHue";
import { useCursorGloss } from "./useCursorGloss";

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
  // Cursor-tracked gloss spotlight on the banner. The hook handles
  // bounding-rect caching, mouse coord normalisation, resize invalidation,
  // and on-leave the last cursor coords are preserved so the opacity fade
  // doesn't snap to center.
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
          <AgentAvatar agent={agent} size={56} shape="square" />
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
          <div className="agent-card-meta">
            <span className="agent-card-model">{agent.model}</span>
            <CardMetaChip
              count={agent.tools.length}
              label="工具"
              icon={<ToolMetaIcon />}
            />
            <CardMetaChip
              count={skillsCount(agent.skills)}
              label={skillsLabel(agent.skills)}
              icon={<SkillMetaIcon />}
              hidden={skillsCount(agent.skills) === null}
            />
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

interface CardMetaChipProps {
  count: number | null;
  label: string;
  icon: React.ReactNode;
  /** When true the chip is omitted entirely — use for fields where
   *  zero ≠ "no signal" (e.g. skills allowlist that's `null = unset`). */
  hidden?: boolean;
}

function CardMetaChip({ count, label, icon, hidden }: CardMetaChipProps) {
  if (hidden) return null;
  if (count === 0) return null;
  if (count === null) return null;
  return (
    <span className="agent-card-chip" aria-label={`${count} ${label}`}>
      <span className="agent-card-chip-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="agent-card-chip-count">{count}</span>
      <span className="agent-card-chip-label">{label}</span>
    </span>
  );
}

/**
 * Skills are 3-state: `null` means "all skills available" (no allowlist
 * configured), an array of N entries means N specific skills, and `[]`
 * (empty array) means "skills disabled". This helper collapses those
 * shapes into the chip's count + label so the card communicates
 * meaningful state in every case.
 */
function skillsCount(skills: ReadonlyArray<string> | null | undefined): number | null {
  if (skills === undefined || skills === null) return null; // unset → hide chip
  return skills.length;
}

function skillsLabel(skills: ReadonlyArray<string> | null | undefined): string {
  if (Array.isArray(skills) && skills.length === 0) return "Skills 已禁用";
  return "Skills";
}

function ToolMetaIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 3l3 3-7 7-3-3z" />
      <path d="M9 4l3 3" />
    </svg>
  );
}

function SkillMetaIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.7L8 11l-3.4 1.8.7-3.7L2.5 6.5l3.8-.5z" />
    </svg>
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

