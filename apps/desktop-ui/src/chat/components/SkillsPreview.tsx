import { parseSkills } from "../editAgentTabs/draft";

export interface SkillsPreviewProps {
  /**
   * Raw text from the user's free-form skills input. The component
   * runs the same `parseSkills` semantics the modals use at submit
   * time, so the live preview matches what would actually be saved.
   */
  text: string;
}

/**
 * Live preview chip(s) for a free-form skills input. Mirrors the
 * tri-state contract of `parseSkills`:
 *   null → "全部 Skills 可用" (no allowlist; default access)
 *   []   → "已禁用" (the literal "none" sentinel)
 *   list → one chip per parsed skill name
 *
 * Used by both the AgentEditModal's OverviewTab and the
 * NewAgentModal's SkillsStep so the create + edit surfaces give
 * the user the same visual feedback for the same input.
 */
export function SkillsPreview({ text }: SkillsPreviewProps) {
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
