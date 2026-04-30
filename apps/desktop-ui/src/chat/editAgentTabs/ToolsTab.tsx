import type { Agent, AgentToolPreset } from "../../api/agents";
import type { ToolCatalogGroup } from "../../api/tools";
import { toolPolicyFromPreset, toolPolicyFromSelection } from "../../api/tools";
import { ToolGroupSelector } from "../ToolGroupSelector";
import { Field } from "../components";
import type { Draft } from "./draft";

export interface ToolsTabProps {
  draft: Draft;
  agentId: string;
  agents: ReadonlyArray<Agent>;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  onChange: (next: Draft) => void;
}

/**
 * Tool preset picker + capability tiles + per-tool detail. Mutations route
 * through the shared policy helpers so the include/exclude lists stay
 * in sync with the surface tool list and preset.
 */
export function ToolsTab({ draft, agentId, agents, toolGroups, onChange }: ToolsTabProps) {
  const handoffCandidates = agents.filter((agent) => agent.id !== agentId);
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
      <section className="agent-handoff-config">
        <div className="agent-handoff-head">
          <h3>可用子智能体</h3>
          <p>主智能体会自主判断是否建议开启，用户确认后才会创建子智能体。</p>
        </div>
        {handoffCandidates.length === 0 ? (
          <div className="tool-group-empty">没有其他智能体可选</div>
        ) : (
          <div className="agent-handoff-list">
            {handoffCandidates.map((agent) => {
              const checked = draft.handoffAgentIds.includes(agent.id);
              return (
                <label className="agent-handoff-row" key={agent.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={`允许建议开启 ${agent.name}`}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...draft.handoffAgentIds, agent.id]
                        : draft.handoffAgentIds.filter((id) => id !== agent.id);
                      onChange({ ...draft, handoffAgentIds: [...new Set(next)] });
                    }}
                  />
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{agent.description || agent.id}</small>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
