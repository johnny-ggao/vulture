import type { AgentToolPreset } from "../../api/agents";
import type { ToolCatalogGroup, ToolPolicyDraft } from "../../api/tools";
import {
  toolPolicyFromPreset,
  toolPolicyFromSelection,
} from "../../api/tools";
import { ToolGroupSelector } from "../ToolGroupSelector";
import { Field } from "../components";
import { StepSection } from "./StepSection";

export interface ToolsStepProps {
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  toolPolicy: ToolPolicyDraft;
  onChange: (next: ToolPolicyDraft) => void;
}

export function ToolsStep({ toolGroups, toolPolicy, onChange }: ToolsStepProps) {
  return (
    <StepSection
      title="工具能力"
      subtitle="先选预设，再按能力类目微调。底层工具会自动展开保存。"
    >
      <div className="new-agent-tools-head">
        <Field label="工具预设">
          <select
            value={toolPolicy.toolPreset}
            onChange={(event) =>
              onChange(toolPolicyFromPreset(event.target.value as AgentToolPreset))
            }
          >
            <option value="minimal">minimal</option>
            <option value="standard">standard</option>
            <option value="developer">developer</option>
            <option value="tl">tl</option>
            <option value="full">full</option>
            <option value="none">none</option>
          </select>
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
