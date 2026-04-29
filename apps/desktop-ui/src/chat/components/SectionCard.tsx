import type { ReactNode } from "react";

export interface SectionCardProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Bordered, rounded content container used inside Settings / Agents pages.
 * Consolidates the previously inline-styled article wrappers.
 */
export function SectionCard({ title, description, actions, children, className }: SectionCardProps) {
  const composed = ["section-card", className].filter(Boolean).join(" ");
  return (
    <article className={composed}>
      {title || description || actions ? (
        <header className="section-card-head">
          {title || description ? (
            <div className="section-card-meta">
              {title ? <h3 className="section-card-title">{title}</h3> : null}
              {description ? <p className="section-card-desc">{description}</p> : null}
            </div>
          ) : null}
          {actions ? <div className="section-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </article>
  );
}
