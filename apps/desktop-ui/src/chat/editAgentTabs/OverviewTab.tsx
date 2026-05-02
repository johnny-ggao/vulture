import { useEffect, useRef, useState } from "react";
import type { Agent, ReasoningLevel } from "../../api/agents";
import { Field, Segmented, SkillsPreview } from "../components";
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
      {agent ? (
        <InfoBlock title="Workspace" value={agent.workspace.path} />
      ) : null}
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
