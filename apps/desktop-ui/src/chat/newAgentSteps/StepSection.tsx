import type { ReactNode } from "react";

export interface StepSectionProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

/** Section header (h2 + subtitle) used uniformly across every wizard step. */
export function StepSection({ title, subtitle, children }: StepSectionProps) {
  return (
    <section className="new-agent-step">
      <div className="new-agent-step-head">
        <h2 className="new-agent-step-title">{title}</h2>
        <p className="new-agent-step-subtitle">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}
