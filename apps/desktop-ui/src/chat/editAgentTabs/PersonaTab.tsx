import { Field } from "../components";
import type { Draft } from "./draft";
import { PERSONA_STARTERS } from "./personaStarters";

export interface PersonaTabProps {
  draft: Draft;
  onChange: (next: Draft) => void;
}

const SOFT_HINT_THRESHOLD = 600;
const HARD_HINT_THRESHOLD = 1200;

/**
 * Persona / Instructions surface — the agent's behaviour brief.
 *
 * Round 14 / 15 additions:
 *   - Live character counter pinned to the field's lower-right.
 *     Tints amber over ~600 chars and danger over ~1200 (no
 *     enforcement — just a visual nudge).
 *   - Inline structural hint above the editor suggesting the order
 *     working personas usually land on (role → goals → boundaries).
 *   - Round 15: a row of starter chips ("通用助手 / 代码审阅 / 写作
 *     助手") that insert a working scaffold into an EMPTY textarea so
 *     the user has somewhere to start. Disabled when content already
 *     exists so we never overwrite a draft.
 */
export function PersonaTab({ draft, onChange }: PersonaTabProps) {
  const length = draft.instructions.length;
  const tone =
    length >= HARD_HINT_THRESHOLD
      ? "danger"
      : length >= SOFT_HINT_THRESHOLD
        ? "soft"
        : "ok";
  const isEmpty = draft.instructions.trim().length === 0;
  return (
    <div className="agent-config-panel" role="tabpanel">
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
              onClick={() =>
                onChange({ ...draft, instructions: starter.body })
              }
            >
              {starter.label}
            </button>
          ))}
        </div>
      ) : null}
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
