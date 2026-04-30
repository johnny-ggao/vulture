export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}

/**
 * Binary on/off switch — better affordance than a button labelled
 * "启用/禁用". Implemented as `role="switch"` for accessibility.
 */
export function Toggle({ checked, onChange, disabled, ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={"toggle-switch" + (checked ? " checked" : "")}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" />
    </button>
  );
}
