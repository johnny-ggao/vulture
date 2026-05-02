import { useEffect, useRef, useState } from "react";
import type { Agent, ReasoningLevel } from "../../api/agents";
import {
  AgentAvatar,
  AVATAR_PRESETS,
  Field,
  Segmented,
  SkillsPreview,
} from "../components";
import type { Draft } from "./draft";

export interface OverviewTabProps {
  /** Null in create mode — Workspace path / id-bound info hide. */
  agent: Agent | null;
  draft: Draft;
  onChange: (next: Draft) => void;
}

const REASONING_OPTIONS: ReadonlyArray<{
  value: ReasoningLevel;
  label: string;
}> = [
  { value: "low", label: "快速" },
  { value: "medium", label: "标准" },
  { value: "high", label: "深度" },
];

/**
 * Top-level identity + meta surface: name, model, reasoning level, skills
 * allowlist, free-form description, and the workspace path readout.
 *
 * Round 14:
 *   - Reasoning level moved from `<select>` to a Segmented control
 *     so the choice is visible and one click away.
 *   - Skills field gets a chip preview underneath that surfaces what
 *     the comma-separated input parses into — `null` (full access),
 *     `[]` (disabled), or N named skills. Cuts the "did I type the
 *     comma right" guesswork.
 */
export function OverviewTab({ agent, draft, onChange }: OverviewTabProps) {
  return (
    <div className="agent-config-panel" role="tabpanel">
      <div className="agent-config-grid">
        <Field label="名称">
          <input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="模型">
          <input
            value={draft.model}
            onChange={(e) => onChange({ ...draft, model: e.target.value })}
          />
        </Field>
        <Field
          label="推理强度"
          hint="低：响应更快；高：让模型思考更久，适合复杂任务。"
        >
          <Segmented
            ariaLabel="推理强度"
            value={draft.reasoning}
            options={REASONING_OPTIONS}
            onChange={(value) => onChange({ ...draft, reasoning: value })}
          />
        </Field>
        <Field label="Skills" hint="留空=全部可用，逗号分隔；输入 none 禁用">
          <input
            aria-label="Skills"
            value={draft.skillsText}
            onChange={(e) => onChange({ ...draft, skillsText: e.target.value })}
          />
          <SkillsPreview text={draft.skillsText} />
        </Field>
      </div>
      <Field label="描述">
        <textarea
          rows={3}
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </Field>
      <AvatarPicker
        agentId={agent?.id ?? (draft.name.trim() || "new-agent")}
        agentName={draft.name.trim() || "新建智能体"}
        selected={draft.avatar}
        onChange={(avatar) => onChange({ ...draft, avatar })}
      />
      {agent ? (
        <InfoBlock title="Workspace" value={agent.workspace.path} />
      ) : null}
    </div>
  );
}

interface AvatarPickerProps {
  agentId: string;
  agentName: string;
  selected: string;
  onChange: (next: string) => void;
}

/**
 * Avatar picker — current selection on the left + a grid of preset
 * tiles on the right. Selecting a preset stores its key on the draft;
 * selecting "默认" (or clicking the active tile to clear) goes back
 * to the deterministic letter avatar.
 *
 * The preset key persists with the agent so the choice carries to
 * the AgentsPage cards, the ChatAgentHeader, and any other surface
 * that renders `<AgentAvatar agent={agent} />`.
 */
function AvatarPicker({
  agentId,
  agentName,
  selected,
  onChange,
}: AvatarPickerProps) {
  const previewAgent = { id: agentId, name: agentName, avatar: selected };
  return (
    <div className="agent-avatar-picker" role="group" aria-label="头像">
      <div className="agent-avatar-picker-label">头像</div>
      <div className="agent-avatar-picker-row">
        <div className="agent-avatar-picker-preview" aria-hidden="true">
          <AgentAvatar agent={previewAgent} size={56} shape="square" />
        </div>
        <div className="agent-avatar-picker-grid" role="radiogroup" aria-label="选择预设头像">
          <button
            type="button"
            role="radio"
            aria-checked={selected === ""}
            className={"agent-avatar-tile" + (selected === "" ? " active" : "")}
            onClick={() => onChange("")}
            title="默认（按名称首字母）"
          >
            <AgentAvatar
              agent={{ id: agentId, name: agentName }}
              size={36}
              shape="square"
            />
            <span className="visually-hidden">默认</span>
          </button>
          {AVATAR_PRESETS.map((preset) => {
            const active = selected === preset.key;
            return (
              <button
                key={preset.key}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={preset.label}
                title={preset.label}
                className={"agent-avatar-tile" + (active ? " active" : "")}
                onClick={() => onChange(preset.key)}
              >
                <AgentAvatar
                  agent={{ id: agentId, name: agentName, avatar: preset.key }}
                  size={36}
                  shape="square"
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function InfoBlock(props: { title: string; value: string }) {
  return (
    <div className="agent-info-block">
      <div className="agent-info-label">{props.title}</div>
      <div className="agent-info-row">
        <code className="agent-info-value">{props.value}</code>
        {props.value ? <CopyValueButton value={props.value} /> : null}
      </div>
    </div>
  );
}

/**
 * Tiny "copy to clipboard" affordance reused for the Workspace path
 * (and any other read-only mono value the modal surfaces). Round 15:
 * makes the path actually take-able rather than something users have
 * to triple-click to select.
 */
function CopyValueButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — silently fall back; the icon just
      // doesn't flash 已复制.
    }
  }
  return (
    <button
      type="button"
      className="agent-info-copy"
      onClick={copy}
      aria-label={`复制 ${value}`}
      title="复制路径"
      data-copied={copied || undefined}
    >
      {copied ? (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="8" height="9" rx="1.5" />
          <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" />
        </svg>
      )}
    </button>
  );
}
