import { StepSection } from "./StepSection";
import { TEMPLATES, type TemplateKey } from "./templates";

export interface TemplateStepProps {
  selected: TemplateKey;
  /** Called when the user picks a template. Receives the new key + the
   *  template's seed instructions and description so the parent can
   *  decide whether to overwrite already-typed fields. */
  onSelect: (
    key: TemplateKey,
    seed: { instructions: string; desc: string },
  ) => void;
}

export function TemplateStep({ selected, onSelect }: TemplateStepProps) {
  return (
    <StepSection
      title="选择模板"
      subtitle="模板只决定初始文案，后续每一步都可以调整。"
    >
      <div className="new-agent-templates">
        {TEMPLATES.map((t) => {
          const TemplateIcon = t.Icon;
          const isSelected = selected === t.key;
          return (
            <button
              key={t.key}
              type="button"
              className={"new-agent-template" + (isSelected ? " selected" : "")}
              onClick={() =>
                onSelect(t.key, {
                  instructions: t.instructions,
                  desc: t.desc,
                })
              }
            >
              <span className="new-agent-template-icon" aria-hidden="true">
                <TemplateIcon />
              </span>
              <span className="new-agent-template-meta">
                <span className="new-agent-template-label">{t.label}</span>
                <span className="new-agent-template-desc">{t.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </StepSection>
  );
}
