import { Field } from "../components";
import type { Draft } from "./draft";

export interface PersonaTabProps {
  draft: Draft;
  onChange: (next: Draft) => void;
}

const SOFT_HINT_THRESHOLD = 600;
const HARD_HINT_THRESHOLD = 1200;

/**
 * Persona / Instructions surface — the agent's behaviour brief.
 *
 * Round 14 additions:
 *   - Live character counter pinned to the field's lower-right via an
 *     absolute overlay (kept outside the `<label>` so it doesn't
 *     pollute the accessible name "Instructions"). Tints amber over
 *     ~600 chars and danger over ~1200 — no enforcement, just a
 *     visual nudge.
 *   - Inline structural hint above the editor suggesting the order
 *     working personas usually land on (role → goals → boundaries).
 */
export function PersonaTab({ draft, onChange }: PersonaTabProps) {
  const length = draft.instructions.length;
  const tone =
    length >= HARD_HINT_THRESHOLD
      ? "danger"
      : length >= SOFT_HINT_THRESHOLD
        ? "soft"
        : "ok";
  return (
    <div className="agent-config-panel" role="tabpanel">
      <p className="agent-persona-hint">
        建议按"角色 → 目标 → 行为边界 / 输出风格"的顺序写。简短、明确比冗长更可靠。
      </p>
      <div className="agent-persona-editor">
        <Field
          label="Instructions"
          hint="定义这个智能体的行为边界、工作方式和输出风格。"
        >
          <textarea
            rows={12}
            value={draft.instructions}
            onChange={(event) =>
              onChange({ ...draft, instructions: event.target.value })
            }
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
    </div>
  );
}
