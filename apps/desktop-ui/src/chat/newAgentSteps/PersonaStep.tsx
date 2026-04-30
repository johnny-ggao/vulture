import { Field } from "../components";
import { StepSection } from "./StepSection";

export interface PersonaStepProps {
  instructions: string;
  placeholder: string;
  onChange: (next: string) => void;
}

export function PersonaStep({
  instructions,
  placeholder,
  onChange,
}: PersonaStepProps) {
  return (
    <StepSection
      title="Persona / Instructions"
      subtitle="写入智能体核心行为边界；创建后仍可在 Agent Core 中细调。"
    >
      <Field label="Instructions">
        <textarea
          value={instructions}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={10}
        />
      </Field>
    </StepSection>
  );
}
