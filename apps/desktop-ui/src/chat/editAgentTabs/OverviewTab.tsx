import type { Agent, ReasoningLevel } from "../../api/agents";
import { Field, Segmented } from "../components";
import type { Draft } from "./draft";
import { parseSkills } from "./draft";

export interface OverviewTabProps {
  agent: Agent;
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
      <InfoBlock title="Workspace" value={agent.workspace.path} />
    </div>
  );
}

/**
 * Live preview of what the skills input parses into. Three states map
 * to three visual treatments so users can confirm intent at a glance:
 *   null → "全部可用" pill (info tone)
 *   []   → "已禁用" pill (warning tone)
 *   list → one chip per skill name (neutral)
 */
function SkillsPreview({ text }: { text: string }) {
  const parsed = parseSkills(text);
  if (parsed === null) {
    return (
      <span
        className="agent-skills-preview agent-skills-preview-default"
        aria-label="Skills 默认全部可用"
      >
        全部 Skills 可用
      </span>
    );
  }
  if (parsed.length === 0) {
    return (
      <span
        className="agent-skills-preview agent-skills-preview-disabled"
        aria-label="Skills 已禁用"
      >
        已禁用
      </span>
    );
  }
  return (
    <div
      className="agent-skills-preview agent-skills-preview-list"
      aria-label={`${parsed.length} 个 Skills`}
    >
      {parsed.map((skill) => (
        <span key={skill} className="agent-skills-chip">
          {skill}
        </span>
      ))}
    </div>
  );
}

function InfoBlock(props: { title: string; value: string }) {
  return (
    <div className="agent-info-block">
      <div className="agent-info-label">{props.title}</div>
      <div className="agent-info-value">{props.value}</div>
    </div>
  );
}
