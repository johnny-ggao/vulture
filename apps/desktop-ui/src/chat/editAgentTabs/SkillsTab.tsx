import { useState } from "react";
import { Field, Segmented } from "../components";
import type { Draft } from "./draft";
import { parseSkills } from "./draft";

export interface SkillsTabProps {
  draft: Draft;
  onChange: (next: Draft) => void;
}

type SkillsMode = "all" | "custom" | "none";

const MODE_OPTIONS: ReadonlyArray<{ value: SkillsMode; label: string }> = [
  { value: "all", label: "全部可用" },
  { value: "custom", label: "自定义" },
  { value: "none", label: "已禁用" },
];

const HINTS: Record<SkillsMode, string> = {
  all: "智能体可调用所有可用 Skills（默认）。",
  custom:
    "限制智能体仅能调用以下 Skills。点击 × 移除，回车或点击「添加」加入新条目。",
  none: "禁用所有 Skills。智能体在对话中不会触发任何 Skill。",
};

/**
 * Skills tab — dedicated surface for the per-agent skill allowlist.
 *
 * Storage stays as `draft.skillsText` (free-form, comma- or newline-
 * separated). The underlying `parseSkills` contract:
 *   ""           → null  (全部可用 / default)
 *   "none"       → []    (已禁用)
 *   "alpha,beta" → list  (自定义 with chips)
 *
 * "自定义 with zero chips" has no representation in skillsText, so
 * we keep the segmented mode in local component state and let the
 * underlying string lag until the user adds the first chip. Without
 * this, clicking 自定义 on an empty list would snap mode back to 全
 * 部可用.
 */
export function SkillsTab({ draft, onChange }: SkillsTabProps) {
  const parsed = parseSkills(draft.skillsText);
  const skills = parsed && parsed.length > 0 ? parsed : [];

  // The visible mode comes from local state when the user has explicitly
  // picked 自定义 with no chips; otherwise it derives from skillsText.
  const derived: SkillsMode =
    parsed === null ? "all" : parsed.length === 0 ? "none" : "custom";
  const [stickyCustom, setStickyCustom] = useState(false);
  const mode: SkillsMode = stickyCustom && derived === "all" ? "custom" : derived;

  const [pending, setPending] = useState("");

  function setMode(next: SkillsMode) {
    if (next === mode) return;
    if (next === "all") {
      setStickyCustom(false);
      onChange({ ...draft, skillsText: "" });
    } else if (next === "none") {
      setStickyCustom(false);
      onChange({ ...draft, skillsText: "none" });
    } else {
      // Custom mode: keep any already-typed chips; if none, sticky
      // the local mode flag so the editor stays open even though
      // skillsText is still "".
      setStickyCustom(true);
      const seed = skills.join(", ");
      onChange({ ...draft, skillsText: seed });
    }
  }

  function addSkill() {
    const value = pending.trim();
    if (!value) return;
    if (skills.includes(value)) {
      setPending("");
      return;
    }
    const next = [...skills, value];
    onChange({ ...draft, skillsText: next.join(", ") });
    setPending("");
  }

  function removeSkill(name: string) {
    const next = skills.filter((s) => s !== name);
    onChange({
      ...draft,
      // Custom-mode with empty list still means "custom" not "none".
      // Keep at least an empty string so the mode segmented control
      // stays anchored on 自定义 until the user explicitly flips it.
      skillsText: next.length === 0 ? "" : next.join(", "),
    });
    // If we just emptied the list, the mode flips back to "all" (the
    // empty-string fallthrough). That matches the parseSkills contract.
  }

  return (
    <div className="agent-config-panel agent-skills-panel" role="tabpanel">
      <Field
        label="Skills 访问策略"
        hint={HINTS[mode]}
      >
        <Segmented
          ariaLabel="Skills 模式"
          value={mode}
          options={MODE_OPTIONS}
          onChange={setMode}
        />
      </Field>

      {mode === "custom" ? (
        <div className="agent-skills-editor">
          <div className="agent-skills-editor-list" role="list">
            {skills.length === 0 ? (
              <p className="agent-skills-editor-empty">
                还没有添加任何 Skill。在下方输入名称后回车，或点击「添加」。
              </p>
            ) : (
              skills.map((skill) => (
                <span
                  key={skill}
                  role="listitem"
                  className="agent-skills-editor-chip"
                >
                  <span className="agent-skills-editor-chip-name">{skill}</span>
                  <button
                    type="button"
                    className="agent-skills-editor-chip-remove"
                    aria-label={`移除 ${skill}`}
                    onClick={() => removeSkill(skill)}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      width="10"
                      height="10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 4l8 8M4 12l8-8" />
                    </svg>
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="agent-skills-editor-add">
            <input
              type="text"
              aria-label="添加 Skill"
              placeholder="输入 Skill 名称…"
              value={pending}
              onChange={(event) => setPending(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addSkill();
                }
              }}
            />
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={addSkill}
              disabled={pending.trim().length === 0}
            >
              添加
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
