import { Field } from "../components";
import { PERSONA_STARTERS } from "../editAgentTabs";
import { StepSection } from "./StepSection";

export interface PersonaStepProps {
  instructions: string;
  placeholder: string;
  onChange: (next: string) => void;
}

const SOFT_HINT_THRESHOLD = 600;
const HARD_HINT_THRESHOLD = 1200;

/**
 * Persona step of the new-agent wizard. Round 16 brings it in line
 * with the AgentEditModal's PersonaTab:
 *   - Inline structural hint above the editor (角色 → 目标 → 风格).
 *   - Live character counter floating over the textarea, with
 *     amber-then-danger thresholds (no enforcement, just a nudge).
 *   - Starter chips when the textarea is empty so the user has a
 *     concrete starting point even when they picked the "blank"
 *     template upstream.
 */
export function PersonaStep({
  instructions,
  placeholder,
  onChange,
}: PersonaStepProps) {
  const length = instructions.length;
  const tone =
    length >= HARD_HINT_THRESHOLD
      ? "danger"
      : length >= SOFT_HINT_THRESHOLD
        ? "soft"
        : "ok";
  const isEmpty = instructions.trim().length === 0;
  return (
    <StepSection
      title="Persona / Instructions"
      subtitle="写入智能体核心行为边界；创建后仍可在 Agent Core 中细调。"
    >
      <p className="agent-persona-hint">
        建议按"角色 → 目标 → 行为边界 / 输出风格"的顺序写。简短、明确比冗长更可靠。
      </p>
      {isEmpty ? (
        <div
          className="agent-persona-starters"
          role="group"
          aria-label="从模板开始"
        >
          <span className="agent-persona-starters-label">从模板开始：</span>
          {PERSONA_STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className="agent-persona-starter"
              onClick={() => onChange(starter.body)}
            >
              {starter.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="agent-persona-editor">
        <Field label="Instructions">
          <textarea
            value={instructions}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={10}
          />
        </Field>
        <span
          className={`agent-persona-counter agent-persona-counter-${tone}`}
          aria-live="polite"
          aria-label={`${length} 字符`}
        >
          {length.toLocaleString("en-US")} 字符
        </span>
      </div>
    </StepSection>
  );
}
