import type { Agent, ReasoningLevel } from "../../api/agents";
import { Field } from "../components";
import type { Draft } from "./draft";

export interface OverviewTabProps {
  agent: Agent;
  draft: Draft;
  onChange: (next: Draft) => void;
}

/**
 * Top-level identity + meta surface: name, model, reasoning level, skills
 * allowlist, free-form description, and the workspace path readout. Pure
 * controlled component — no state of its own.
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
        <Field label="推理强度">
          <select
            value={draft.reasoning}
            onChange={(e) =>
              onChange({ ...draft, reasoning: e.target.value as ReasoningLevel })
            }
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
        <Field label="Skills" hint="留空=全部可用，逗号分隔；输入 none 禁用">
          <input
            aria-label="Skills"
            value={draft.skillsText}
            onChange={(e) => onChange({ ...draft, skillsText: e.target.value })}
          />
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

function InfoBlock(props: { title: string; value: string }) {
  return (
    <div className="agent-info-block">
      <div className="agent-info-label">{props.title}</div>
      <div className="agent-info-value">{props.value}</div>
    </div>
  );
}
