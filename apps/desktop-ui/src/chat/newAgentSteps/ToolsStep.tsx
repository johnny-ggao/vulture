import type { AgentToolPreset } from "../../api/agents";
import type { ToolCatalogGroup, ToolPolicyDraft } from "../../api/tools";
import {
  toolPolicyFromPreset,
  toolPolicyFromSelection,
} from "../../api/tools";
import { ToolGroupSelector } from "../ToolGroupSelector";
import { Field, Segmented } from "../components";
import { StepSection } from "./StepSection";

export interface ToolsStepProps {
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  toolPolicy: ToolPolicyDraft;
  onChange: (next: ToolPolicyDraft) => void;
}

const PRESET_OPTIONS: ReadonlyArray<{
  value: AgentToolPreset;
  label: string;
}> = [
  { value: "minimal", label: "最小" },
  { value: "standard", label: "标准" },
  { value: "developer", label: "开发者" },
  { value: "tl", label: "TL" },
  { value: "full", label: "全部" },
  { value: "none", label: "无" },
];

/**
 * Tools step of the new-agent wizard. Round 16: preset uses the same
 * Segmented pill the AgentEditModal's ToolsTab uses, with the same
 * Chinese labels — so create + edit share the affordance.
 */
export function ToolsStep({ toolGroups, toolPolicy, onChange }: ToolsStepProps) {
  return (
    <StepSection
      title="工具能力"
      subtitle="先选预设，再按能力类目微调。底层工具会自动展开保存。"
    >
      <div className="new-agent-tools-head">
        <Field
          label="工具预设"
          hint="预设决定默认开关；下方类目可继续微调。"
        >
          <Segmented
            ariaLabel="工具预设"
            value={toolPolicy.toolPreset}
            options={PRESET_OPTIONS}
            onChange={(value) => onChange(toolPolicyFromPreset(value))}
          />
        </Field>
        <div className="new-agent-tools-buttons">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onChange(toolPolicyFromPreset("full"))}
          >
            全选
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onChange(toolPolicyFromPreset("none"))}
          >
            清空
          </button>
        </div>
      </div>
      <ToolGroupSelector
        groups={toolGroups}
        selected={toolPolicy.tools}
        onChange={(tools) =>
          onChange(toolPolicyFromSelection(toolPolicy.toolPreset, tools))
        }
      />
    </StepSection>
  );
}
