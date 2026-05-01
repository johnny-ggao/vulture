import type { ReactNode } from "react";

/* ============================================================
 * SettingsSection — shared shell for every Settings sub-page.
 *
 * Replaces four divergent header patterns (no-title / h2 / h3 /
 * SectionCard.title) with a single h2 + sub + optional right-side
 * action layout. Sticky-positioned with a soft blurred backdrop
 * so the section title stays anchored as the body scrolls.
 *
 * Body content fills the rest of the panel; sub-cards inside should
 * use SectionCard / section-group / etc. — this wrapper is
 * intentionally container-less so child surfaces breathe.
 * ============================================================ */
export interface SettingsSectionProps {
  /** h2 — the section title. Should match the rail label. */
  title: string;
  /** Optional one-line description below the title. */
  description?: string;
  /** Optional right-aligned action (refresh button, status pill, etc.). */
  action?: ReactNode;
  /** Body content. */
  children: ReactNode;
  /** Optional anchor id for deep-linking and sticky-scroll targeting. */
  id?: string;
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  id,
}: SettingsSectionProps) {
  return (
    <section className="settings-section" id={id}>
      <header className="settings-section-head">
        <div className="settings-section-titles">
          <h2 className="settings-section-title">{title}</h2>
          {description ? (
            <p className="settings-section-sub">{description}</p>
          ) : null}
        </div>
        {action ? <div className="settings-section-action">{action}</div> : null}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}
