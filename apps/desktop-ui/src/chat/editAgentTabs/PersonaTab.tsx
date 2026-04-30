import { Field } from "../components";
import type { Draft } from "./draft";

export interface PersonaTabProps {
  draft: Draft;
  onChange: (next: Draft) => void;
}

/**
 * Single tall textarea for the agent's behavioural prompt. Kept separate
 * from Overview so the user has plenty of vertical room to write — the
 * page-level tab navigation lets us trade modal real estate per concern.
 */
export function PersonaTab({ draft, onChange }: PersonaTabProps) {
  return (
    <div className="agent-config-panel" role="tabpanel">
      <Field
        label="Instructions"
        hint="定义这个智能体的行为边界、工作方式和输出风格。"
      >
        <textarea
          rows={14}
          value={draft.instructions}
          onChange={(e) => onChange({ ...draft, instructions: e.target.value })}
        />
      </Field>
    </div>
  );
}
