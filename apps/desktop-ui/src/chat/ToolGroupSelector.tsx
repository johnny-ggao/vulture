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
    return <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>工具 catalog 加载中</div>;
  }

  const knownTools = new Set(props.groups.flatMap((group) => group.items.map((tool) => tool.id)));
  const capabilities = TOOL_CAPABILITIES.map((capability) => ({
    ...capability,
    toolIds: capability.toolIds.filter((tool) => knownTools.has(tool)),
  })).filter((capability) => capability.toolIds.length > 0);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        {capabilities.map((capability) => {
          const selectedCount = capability.toolIds.filter((tool) => props.selected.includes(tool)).length;
          const allSelected = selectedCount === capability.toolIds.length && capability.toolIds.length > 0;
          const someSelected = selectedCount > 0 && !allSelected;
          return (
            <button
              key={capability.id}
              type="button"
              onClick={() => props.onChange(toggleCapability(props.selected, capability))}
              aria-pressed={allSelected}
              style={{
                textAlign: "left",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 8,
                alignItems: "start",
                border: allSelected || someSelected ? "1px solid var(--brand-500)" : "1px solid var(--fill-tertiary)",
                borderRadius: "var(--radius-md)",
                padding: "12px 14px",
                background: allSelected || someSelected ? "var(--brand-050)" : "var(--bg-primary)",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              <span style={{ display: "grid", gap: 4 }}>
                <span style={{ fontWeight: 650, fontSize: 13 }}>{capability.label}</span>
                <span style={{ color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.35 }}>
                  {capability.description}
                </span>
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: allSelected || someSelected ? "var(--brand-600)" : "var(--text-tertiary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {selectedCount}/{capability.toolIds.length}
              </span>
            </button>
          );
        })}
      </div>

      <details>
        <summary style={{ cursor: "pointer", color: "var(--text-secondary)", fontSize: 12 }}>
          查看底层工具明细
        </summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 10 }}>
          {props.groups.map((group) => {
            const selectedCount = group.items.filter((tool) => props.selected.includes(tool.id)).length;
            const allSelected = selectedCount === group.items.length && group.items.length > 0;
            return (
              <div
                key={group.id}
                style={{
                  display: "grid",
                  gap: 8,
                  alignContent: "start",
                  border: "1px solid var(--fill-tertiary)",
                  borderRadius: "var(--radius-sm)",
                  padding: "8px 10px",
                  background: allSelected ? "var(--brand-050)" : "var(--bg-primary)",
                }}
              >
                <label
                  style={{
                    display: "grid",
                    gridTemplateColumns: "16px 1fr auto",
                    gap: 8,
                    alignItems: "center",
                    fontSize: 12,
                    color: "var(--text-primary)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => props.onChange(toggleGroup(props.selected, group))}
                  />
                  <span style={{ fontWeight: 650 }}>{group.label}</span>
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {selectedCount}/{group.items.length}
                  </span>
                </label>
                <div style={{ display: "grid", gap: 5, paddingLeft: 24 }}>
                  {group.items.map((tool) => (
                    <label
                      key={tool.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "16px 1fr auto",
                        gap: 8,
                        alignItems: "center",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={props.selected.includes(tool.id)}
                        onChange={() => props.onChange(toggleTool(props.selected, tool.id))}
                      />
                      <span>{tool.label}</span>
                      <span style={{ color: "var(--text-tertiary)" }}>
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
