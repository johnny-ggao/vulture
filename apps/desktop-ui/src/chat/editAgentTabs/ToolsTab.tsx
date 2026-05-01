import type { AgentToolPreset } from "../../api/agents";
import type { ToolCatalogGroup } from "../../api/tools";
import { toolPolicyFromPreset, toolPolicyFromSelection } from "../../api/tools";
import { ToolGroupSelector } from "../ToolGroupSelector";
import { Field, Segmented } from "../components";
import type { Draft } from "./draft";

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

export interface ToolsTabProps {
  draft: Draft;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  onChange: (next: Draft) => void;
}

/**
 * Tool preset picker + capability tiles + per-tool detail. Mutations route
 * through the shared policy helpers so the include/exclude lists stay
 * in sync with the surface tool list and preset.
 *
 * Round 18: handoff selection moved out to its own 协作 tab.
 */
export function ToolsTab({ draft, toolGroups, onChange }: ToolsTabProps) {
  return (
    <div className="agent-config-panel" role="tabpanel">
      <section className="agent-tools">
        <div className="agent-tools-head">
          <Field
            label="Tools 预设"
            hint="预设决定默认开关；下方类目可继续微调。"
          >
            <Segmented
              ariaLabel="Tools 预设"
              value={draft.toolPreset}
              options={PRESET_OPTIONS}
              onChange={(value) =>
                onChange({ ...draft, ...toolPolicyFromPreset(value) })
              }
            />
          </Field>
          <div className="agent-tools-presets">
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                onChange({ ...draft, ...toolPolicyFromPreset("full") })
              }
            >
              全选
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                onChange({ ...draft, ...toolPolicyFromPreset("none") })
              }
            >
              清空
            </button>
          </div>
        </div>
        <ToolGroupSelector
          groups={toolGroups}
          selected={draft.tools}
          onChange={(tools) =>
            onChange({
              ...draft,
              ...toolPolicyFromSelection(draft.toolPreset, tools),
            })
          }
        />
      </section>
    </div>
  );
}
