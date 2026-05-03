export interface AgentCreateTileProps {
  onClick: () => void;
  /** Defaults to "新建智能体". Allowed for surfaces that prefer "新增"
   *  or context-specific labels without forking the styling. */
  label?: string;
}

/**
 * Grid-aligned dashed CTA tile that lives inside the agents grid as
 * the first child. Same vertical rhythm as a regular AgentCard so the
 * grid stays tidy (uniform min-height + center-aligned content),
 * borrowed from Accio's product tile language.
 */
export function AgentCreateTile({
  onClick,
  label = "新建智能体",
}: AgentCreateTileProps) {
  return (
    <button
      type="button"
      className="agent-create-tile"
      onClick={onClick}
      aria-label={label}
    >
      <span className="agent-create-tile-glyph" aria-hidden="true">
        <PlusIcon />
      </span>
      <span className="agent-create-tile-label">{label}</span>
      <span className="agent-create-tile-hint">从模板或空白起步</span>
    </button>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
