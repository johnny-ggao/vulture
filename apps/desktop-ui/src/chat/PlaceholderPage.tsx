import type { ReactNode } from "react";

export interface PlaceholderPageProps {
  title: string;
  description: string;
  /** Optional icon shown in the hero badge. Defaults to a clock glyph. */
  icon?: ReactNode;
  /**
   * Short label for the status pill on the hero (e.g. "规划中"). Defaults
   * to "即将上线" so a stub never reads as "broken".
   */
  status?: string;
  /**
   * Bullet teasers describing what the surface will do when shipped.
   * Each becomes a row with a small dot indicator. Empty list hides
   * the section entirely.
   */
  teasers?: ReadonlyArray<string>;
  /** Slot for arbitrary content below the hero (rare). */
  children?: ReactNode;
}

/**
 * Generic "coming soon" view for routes whose backend isn't built yet.
 * Used by 插件 and 定时任务 today. The visual treatment turns a stub
 * into a deliberate roadmap card — large icon, clear status, teaser
 * bullets — so the user understands "we're aware and have plans"
 * rather than "this page is broken or empty".
 */
export function PlaceholderPage(props: PlaceholderPageProps) {
  return (
    <div className="page placeholder-page">
      <div className="placeholder-hero" role="region" aria-label={props.title}>
        <div className="placeholder-hero-icon" aria-hidden="true">
          {props.icon ?? <DefaultIcon />}
        </div>
        <span className="placeholder-hero-status">{props.status ?? "即将上线"}</span>
        <h1 className="placeholder-hero-title">{props.title}</h1>
        <p className="placeholder-hero-sub">{props.description}</p>
        {props.teasers && props.teasers.length > 0 ? (
          <ul className="placeholder-hero-teasers" aria-label="规划中">
            {props.teasers.map((line) => (
              <li key={line}>
                <span className="placeholder-hero-bullet" aria-hidden="true" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

function DefaultIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
