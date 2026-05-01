import type { ReactNode } from "react";
import { Badge } from "../components";

export interface SaveStatusIndicatorProps {
  saving: boolean;
  isDirty: boolean;
  savedFlash: boolean;
}

/**
 * Tiny pill that surfaces the save lifecycle (未保存 → 保存中 → 已保存)
 * next to the modal's primary save action.
 *
 * Always renders a live region (aria-live="polite", aria-atomic="true")
 * so screen-reader users hear state changes — critical for confirming
 * that ⌘S actually fired, that a save is in progress, and that the
 * write succeeded. When the draft is clean and idle, the live region
 * stays mounted but empty so future announcements aren't dropped.
 */
export function SaveStatusIndicator({
  saving,
  isDirty,
  savedFlash,
}: SaveStatusIndicatorProps): ReactNode {
  let inner: ReactNode = null;
  let label = "";
  if (saving) {
    inner = <Badge tone="info">保存中…</Badge>;
    label = "保存中";
  } else if (savedFlash) {
    inner = <Badge tone="success">已保存</Badge>;
    label = "已保存";
  } else if (isDirty) {
    inner = <Badge tone="warning">未保存</Badge>;
    label = "有未保存的修改";
  }
  return (
    <span
      className="save-status-live"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={label || "保存状态"}
    >
      {inner}
    </span>
  );
}
