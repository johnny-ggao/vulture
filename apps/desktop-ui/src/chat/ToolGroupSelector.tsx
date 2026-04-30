import type { AgentToolName } from "../api/agents";
import { TOOL_CAPABILITIES } from "../api/tools";
import type { ToolCapability, ToolCatalogGroup } from "../api/tools";

export interface ToolGroupSelectorProps {
  groups: ReadonlyArray<ToolCatalogGroup>;
  selected: ReadonlyArray<AgentToolName>;
  onChange: (tools: AgentToolName[]) => void;
}

export function ToolGroupSelector(props: ToolGroupSelectorProps) {
  if (props.groups.length === 0) {
    return <div className="tool-group-empty">工具 catalog 加载中</div>;
  }

  const knownTools = new Set(props.groups.flatMap((group) => group.items.map((tool) => tool.id)));
  const capabilities = TOOL_CAPABILITIES.map((capability) => ({
    ...capability,
    toolIds: capability.toolIds.filter((tool) => knownTools.has(tool)),
  })).filter((capability) => capability.toolIds.length > 0);

  return (
    <div className="tool-group-root">
      <div className="tool-capabilities">
        {capabilities.map((capability) => {
          const selectedCount = capability.toolIds.filter((tool) => props.selected.includes(tool)).length;
          const allSelected = selectedCount === capability.toolIds.length && capability.toolIds.length > 0;
          const someSelected = selectedCount > 0 && !allSelected;
          const tinted = allSelected || someSelected;
          return (
            <button
              key={capability.id}
              type="button"
              className="tool-capability"
              data-tinted={tinted ? "true" : undefined}
              onClick={() => props.onChange(toggleCapability(props.selected, capability))}
              aria-pressed={allSelected}
            >
              <span className="tool-capability-meta">
                <span className="tool-capability-label">{capability.label}</span>
                <span className="tool-capability-desc">
                  {capability.description}
                </span>
              </span>
              <span className="tool-capability-count">
                {selectedCount}/{capability.toolIds.length}
              </span>
            </button>
          );
        })}
      </div>

      <details className="tool-group-detail">
        <summary>查看底层工具明细</summary>
        <div className="tool-groups">
          {props.groups.map((group) => {
            const selectedCount = group.items.filter((tool) => props.selected.includes(tool.id)).length;
            const allSelected = selectedCount === group.items.length && group.items.length > 0;
            return (
              <div
                key={group.id}
                className="tool-group"
                data-tinted={allSelected ? "true" : undefined}
              >
                <label className="tool-group-head">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => props.onChange(toggleGroup(props.selected, group))}
                  />
                  <span className="tool-group-label">{group.label}</span>
                  <span className="tool-group-count">
                    {selectedCount}/{group.items.length}
                  </span>
                </label>
                <div className="tool-list">
                  {group.items.map((tool) => (
                    <label key={tool.id} className="tool-row">
                      <input
                        type="checkbox"
                        checked={props.selected.includes(tool.id)}
                        onChange={() => props.onChange(toggleTool(props.selected, tool.id))}
                      />
                      <span>{tool.label}</span>
                      <span className="tool-row-meta">
                        {tool.idempotent ? "retry-safe" : tool.risk}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function toggleCapability(
  current: ReadonlyArray<AgentToolName>,
  capability: ToolCapability,
): AgentToolName[] {
  const allSelected = capability.toolIds.every((tool) => current.includes(tool));
  if (allSelected) {
    return current.filter((tool) => !capability.toolIds.includes(tool));
  }
  const next = new Set(current);
  for (const tool of capability.toolIds) next.add(tool);
  return [...next];
}

function toggleTool(current: ReadonlyArray<AgentToolName>, tool: AgentToolName): AgentToolName[] {
  return current.includes(tool)
    ? current.filter((item) => item !== tool)
    : [...current, tool];
}

function toggleGroup(
  current: ReadonlyArray<AgentToolName>,
  group: ToolCatalogGroup,
): AgentToolName[] {
  const groupTools = group.items.map((tool) => tool.id);
  const allSelected = groupTools.every((tool) => current.includes(tool));
  if (allSelected) {
    return current.filter((tool) => !groupTools.includes(tool));
  }
  const next = new Set(current);
  for (const tool of groupTools) next.add(tool);
  return [...next];
}
