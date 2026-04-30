import { Field } from "../components";
import type { Draft } from "./draft";

export interface PersonaTabProps {
  draft: Draft;
  onChange: (next: Draft) => void;
}

const SOFT_HINT_THRESHOLD = 600;
const HARD_HINT_THRESHOLD = 1200;

interface PersonaStarter {
  /** Short label shown on the chip. */
  label: string;
  /** Multi-line scaffold inserted into the textarea when the chip is
   *  clicked while empty. */
  body: string;
}

const STARTERS: ReadonlyArray<PersonaStarter> = [
  {
    label: "通用助手",
    body: [
      "你是一名专业的助手。",
      "",
      "目标：",
      "- 理解用户意图，给出清晰、可操作的回答。",
      "- 复杂问题先拆步骤，再展开。",
      "",
      "风格：",
      "- 简洁优先，避免冗长的客套话。",
      "- 关键结论放在最前。",
    ].join("\n"),
  },
  {
    label: "代码审阅",
    body: [
      "你是一名严谨的代码审阅者。",
      "",
      "重点关注：",
      "- 正确性：边界、并发、错误处理是否完整。",
      "- 可读性：命名、注释、函数粒度。",
      "- 安全：注入、未校验输入、敏感信息泄露。",
      "",
      "输出：",
      "- 先按「严重 / 一般 / 建议」分级列出问题。",
      "- 给出具体的修改建议或代码片段。",
    ].join("\n"),
  },
  {
    label: "写作助手",
    body: [
      "你是一名细致的中文写作助手。",
      "",
      "在用户给出选题或草稿时：",
      "- 提供 2-3 个不同角度的开头方案。",
      "- 检查逻辑、连接词、可读性。",
      "- 润色措辞但保留作者声音。",
    ].join("\n"),
  },
];

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
          {STARTERS.map((starter) => (
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
