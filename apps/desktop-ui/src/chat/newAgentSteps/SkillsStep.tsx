import { Field, SkillsPreview } from "../components";
import { StepSection } from "./StepSection";

export interface SkillsStepProps {
  skillsText: string;
  onChange: (next: string) => void;
}

/**
 * Skills step of the new-agent wizard. Round 16: shares the live
 * tri-state preview with the AgentEditModal's OverviewTab via the
 * shared `<SkillsPreview>` component, so users see the same visual
 * confirmation regardless of which surface they typed in.
 */
export function SkillsStep({ skillsText, onChange }: SkillsStepProps) {
  return (
    <StepSection
      title="Skills"
      subtitle="留空表示可加载全部已启用 Skills；输入 none 表示禁用。"
    >
      <Field label="Skills" hint="留空=全部可用，逗号分隔；输入 none 禁用">
        <input
          aria-label="Skills"
          value={skillsText}
          onChange={(e) => onChange(e.target.value)}
          placeholder="留空=全部可用"
        />
        <SkillsPreview text={skillsText} />
      </Field>
    </StepSection>
  );
}
