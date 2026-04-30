import type { ReasoningLevel } from "../../api/agents";
import { Field, Segmented } from "../components";
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

const REASONING_OPTIONS: ReadonlyArray<{
  value: ReasoningLevel;
  label: string;
}> = [
  { value: "low", label: "快速" },
  { value: "medium", label: "标准" },
  { value: "high", label: "深度" },
];

/**
 * Identity step of the new-agent wizard. Round 16: reasoning level
 * uses the same Segmented control the AgentEditModal's OverviewTab
 * uses, so create + edit show the choice with the same affordance.
 */
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
        <Field
          label="推理强度"
          hint="低：响应更快；高：让模型思考更久，适合复杂任务。"
        >
          <Segmented
            ariaLabel="推理强度"
            value={reasoning}
            options={REASONING_OPTIONS}
            onChange={onReasoning}
          />
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
