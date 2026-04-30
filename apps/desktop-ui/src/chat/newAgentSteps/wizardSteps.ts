/**
 * Wizard step model — pure types + ordered metadata. No React, no JSX, so
 * the new-agent shell can derive `stepIndex` / canGoNext / progress
 * percentages from this data without dragging the StepRail component
 * (and its SVG) into call sites that don't render the rail.
 */

export type WizardStep = "template" | "identity" | "persona" | "tools" | "skills";

export interface StepInfo {
  id: WizardStep;
  label: string;
  desc: string;
}

// Step order matches Accio: Template → Identity → Persona → Tools → Skills.
// Persona slots before Tools because the agent's role determines which tools
// it actually needs.
export const STEPS: ReadonlyArray<StepInfo> = [
  { id: "template", label: "模板",     desc: "选择起点" },
  { id: "identity", label: "身份与模型", desc: "名称、模型、描述" },
  { id: "persona",  label: "Persona",   desc: "行为边界" },
  { id: "tools",    label: "工具能力",  desc: "预设与类目" },
  { id: "skills",   label: "Skills",    desc: "能力包策略" },
];
