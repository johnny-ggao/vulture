import type { ReactNode } from "react";
import { Badge } from "../components";

export interface SaveStatusIndicatorProps {
  saving: boolean;
  isDirty: boolean;
  savedFlash: boolean;
}

/**
 * Tiny pill that surfaces the save lifecycle (未保存 → 保存中 → 已保存)
 * next to the modal's primary save action. Renders nothing when the
 * draft matches the upstream agent and there's no in-flight save.
 */
export function SaveStatusIndicator({
  saving,
  isDirty,
  savedFlash,
}: SaveStatusIndicatorProps): ReactNode {
  if (saving) return <Badge tone="info">保存中…</Badge>;
  if (savedFlash) return <Badge tone="success">已保存</Badge>;
  if (isDirty) return <Badge tone="warning">未保存</Badge>;
  return null;
}
