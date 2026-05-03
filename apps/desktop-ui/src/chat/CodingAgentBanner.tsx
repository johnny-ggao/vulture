import { useState } from "react";

export interface CodingAgentBannerProps {
  agentId: string;
  onOpenAgentEdit: (agentId: string) => void;
}

/**
 * Surfaces a one-time nudge when Vulture Coding is still bound to the
 * private workspace. Per-session dismissal — once the user closes it,
 * we don't show it again until the page reloads. Once the user picks a
 * non-private workspace, the parent stops rendering this component
 * entirely (so dismiss state becomes irrelevant).
 */
export function CodingAgentBanner({ agentId, onOpenAgentEdit }: CodingAgentBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="coding-agent-banner" role="status">
      <span className="coding-agent-banner-text">
        Vulture Coding 还在隔离工作区里运行。点这里切换到你的项目目录 →
      </span>
      <div className="coding-agent-banner-actions">
        <button
          type="button"
          className="coding-agent-banner-action"
          onClick={() => onOpenAgentEdit(agentId)}
        >
          切换工作区
        </button>
        <button
          type="button"
          className="coding-agent-banner-dismiss"
          aria-label="dismiss"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
