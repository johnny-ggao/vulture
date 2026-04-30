import type { ReactNode } from "react";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Optional aria-label override; defaults to the visible label when
   *  it is a plain string. Set this when the label is a node and a
   *  meaningful screen-reader label can't be inferred from it. */
  ariaLabel?: string;
  /** Disabled segment (rare — typically the value should be removed
   *  from `options` instead, but kept here for the "preset locked"
   *  edge cases). */
  disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  /**
   * Stable string id for screen readers. The radio group needs a name
   * for proper grouping; we don't accept ad-hoc DOM ids here so the
   * component owns its naming.
   */
  ariaLabel: string;
  value: V;
  options: ReadonlyArray<SegmentedOption<V>>;
  onChange: (next: V) => void;
  /** Tunes density. `compact` for in-toolbar usage (~24px tall), `cozy`
   *  (default) for inline form fields (~28px tall). */
  size?: "compact" | "cozy";
  /** Visual variant — default uses fill-quaternary track; `subtle` is
   *  borderless on a transparent track for cases where the surrounding
   *  card already provides separation. */
  tone?: "default" | "subtle";
}

/**
 * Pill-shaped segmented control — round 14 generalisation of the
 * AgentsPage sort affordance. Replaces ad-hoc `<select>` dropdowns
 * across the agent surfaces (modal tabs, reasoning level, tool
 * preset) so the entire surface uses the same direct-manipulation
 * idiom.
 *
 * Implementation: WAI-ARIA radiogroup with each segment as a
 * `<button role="radio">`. Keyboard support comes for free via
 * native focus + Enter/Space; arrow-key navigation is intentionally
 * left to native focus order so users can Tab between segments
 * (matches OS-level segmented controls — unlike native `<input
 * type="radio">` groups, our segments are independent buttons that
 * each call onChange directly).
 */
export function Segmented<V extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  size = "cozy",
  tone = "default",
}: SegmentedProps<V>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`segmented segmented-${size} segmented-${tone}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        const labelText =
          option.ariaLabel ??
          (typeof option.label === "string" ? option.label : undefined);
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={labelText}
            disabled={option.disabled}
            className={"segmented-segment" + (active ? " active" : "")}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
