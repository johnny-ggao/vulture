import type { AgentToolPreset } from "../../api/agents";
import type { ToolCatalogGroup } from "../../api/tools";
import { toolPolicyFromPreset, toolPolicyFromSelection } from "../../api/tools";
import { ToolGroupSelector } from "../ToolGroupSelector";
import { Field } from "../components";
import type { Draft } from "./draft";

export interface ToolsTabProps {
  draft: Draft;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  onChange: (next: Draft) => void;
}

/**
 * Tool preset picker + capability tiles + per-tool detail. Mutations route
 * through the shared policy helpers so the include/exclude lists stay
 * in sync with the surface tool list and preset.
 */
export function ToolsTab({ draft, toolGroups, onChange }: ToolsTabProps) {
  return (
    <div className="agent-config-panel" role="tabpanel">
      <section className="agent-tools">
        <div className="agent-tools-head">
          <Field label="Tools 预设">
            <select
              value={draft.toolPreset}
              onChange={(event) =>
                onChange({
                  ...draft,
                  ...toolPolicyFromPreset(event.target.value as AgentToolPreset),
                })
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
