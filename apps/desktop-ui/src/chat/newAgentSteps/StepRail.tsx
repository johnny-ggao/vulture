import { STEPS, type WizardStep } from "./wizardSteps";

export interface StepRailProps {
  step: WizardStep;
  /** Called when the user clicks a rail item. Caller decides whether to
   *  honour the request (the wizard gates jumps past identity behind
   *  having a name typed). */
  onSelect: (step: WizardStep) => void;
  /**
   * Render-time gate: which step indices should appear "clickable". The
   * caller computes this based on draft state (e.g. don't allow jumping
   * past identity until name is typed). Items not in this set still
   * render, just don't fire onSelect.
   */
  isReachable: (step: WizardStep, index: number) => boolean;
}

/** Left-side rail with one button per wizard step. */
export function StepRail({ step, onSelect, isReachable }: StepRailProps) {
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  return (
    <aside className="new-agent-rail" aria-label="创建步骤">
      {STEPS.map((item, index) => {
        const active = item.id === step;
        const complete = index < stepIndex;
        return (
          <button
            key={item.id}
            type="button"
            className={
              "new-agent-rail-item" +
              (active ? " active" : "") +
              (complete ? " complete" : "")
            }
            onClick={() => {
              if (isReachable(item.id, index)) onSelect(item.id);
            }}
          >
            <span className="new-agent-rail-bullet">
              {complete ? <CheckSmall /> : index + 1}
            </span>
            <span className="new-agent-rail-text">
              <span className="new-agent-rail-label">{item.label}</span>
              <span className="new-agent-rail-desc">{item.desc}</span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

function CheckSmall() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
