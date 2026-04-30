import type * as React from "react";
import { AgentAvatar, hashHue, useCursorGloss } from "../components";

export interface PreviewCardProps {
  /** Synthetic agent shape — id is the entered name (or template key
   *  fallback) so the hashed banner hue updates as the user types. */
  agent: { id: string; name: string };
  desc: string;
  model: string;
  toolCount: number;
  skillsSummary: string;
  /** Bottom-of-the-aside summary; falls back to a hint when empty. */
  instructionsPreview: string;
}

/**
 * Live preview aside for the new-agent wizard. Renders the same banner +
 * floating-avatar treatment the agent will get on its real AgentCard,
 * driven by the synthetic id so colour identity is consistent before
 * and after creation.
 *
 * Hooks discipline: `useCursorGloss` runs at the top of this component,
 * so the function body MUST NOT introduce its own early returns above
 * that call. Mounting the component conditionally from the parent is
 * fine — the rule is that within ONE render, the hook order can't
 * change. The wizard takes the safe path of only mounting the modal
 * body (and therefore PreviewCard) when the modal is open.
 */
export function PreviewCard({
  agent,
  desc,
  model,
  toolCount,
  skillsSummary,
  instructionsPreview,
}: PreviewCardProps) {
  const { ref, ...gloss } = useCursorGloss<HTMLDivElement>();
  return (
    <aside className="new-agent-preview" aria-label="实时预览">
      <div className="new-agent-preview-label">Live Preview</div>
      <div className="new-agent-preview-card" ref={ref} {...gloss}>
        <div
          className="new-agent-preview-banner"
          style={
            {
              "--banner-hue": hashHue(agent.id).toString(),
            } as React.CSSProperties
          }
        />
        <div className="new-agent-preview-avatar-frame">
          <AgentAvatar agent={agent} size={54} shape="square" />
        </div>
        <div className="new-agent-preview-body">
          <div className="new-agent-preview-name">{agent.name}</div>
          <div className="new-agent-preview-desc">{desc}</div>
          <div className="new-agent-preview-rows">
            <PreviewRow label="Model" value={model} />
            <PreviewRow label="Tools" value={`${toolCount}`} />
            <PreviewRow label="Skills" value={skillsSummary} />
          </div>
        </div>
      </div>
      <div className="new-agent-preview-instructions">
        {instructionsPreview ||
          "选择模板并填写名称后，这里会显示最终创建时的行为摘要。"}
      </div>
    </aside>
  );
}

function PreviewRow(props: { label: string; value: string }) {
  return (
    <div className="new-agent-preview-row">
      <span className="new-agent-preview-row-label">{props.label}</span>
      <span className="new-agent-preview-row-value">{props.value}</span>
    </div>
  );
}
