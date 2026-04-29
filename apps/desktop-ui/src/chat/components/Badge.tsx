import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
}

/**
 * Compact pill label used to convey status, source, or capability.
 * Rendered as a `<span>` so it is inline with surrounding text.
 */
export function Badge({ children, tone = "neutral" }: BadgeProps) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
