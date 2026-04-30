import type { ReasoningLevel } from "../../api/agents";
import { Field } from "../components";
import { StepSection } from "./StepSection";

export interface IdentityStepProps {
  name: string;
  model: string;
  reasoning: ReasoningLevel;
  desc: string;
  descPlaceholder: string;
  onName: (next: string) => void;
  onModel: (next: string) => void;
  onReasoning: (next: ReasoningLevel) => void;
  onDesc: (next: string) => void;
}

export function IdentityStep({
  name,
  model,
  reasoning,
  desc,
  descPlaceholder,
  onName,
  onModel,
  onReasoning,
  onDesc,
}: IdentityStepProps) {
  return (
    <StepSection
      title="身份与模型"
      subtitle="定义这个智能体在列表、对话和运行时使用的基础配置。"
    >
      <div className="new-agent-grid-2">
        <Field label="名称" required>
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="例：周报助手"
          />
        </Field>
        <Field label="模型">
          <input value={model} onChange={(e) => onModel(e.target.value)} />
        </Field>
        <Field label="推理强度">
          <select
            value={reasoning}
            onChange={(e) => onReasoning(e.target.value as ReasoningLevel)}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
      </div>
      <Field label="描述">
        <textarea
          value={desc}
          onChange={(e) => onDesc(e.target.value)}
          placeholder={descPlaceholder}
          rows={4}
        />
      </Field>
    </StepSection>
  );
}
