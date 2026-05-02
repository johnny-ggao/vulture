import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalDecision } from "../api/runs";
import { summarizeToolInput } from "./toolPresentation";

export interface ApprovalCardProps {
  callId: string;
  tool: string;
  reason: string;
  /**
   * Optional: the input the agent wants to send to the tool. When present
   * we render it as a code preview so the user can review what's about to
   * run before deciding. Omitted for legacy events that didn't carry
   * input on the ask payload.
   */
  input?: unknown;
  submitting: boolean;
  onDecide: (callId: string, decision: ApprovalDecision) => void;
}

/**
 * "Hold for confirmation" card the run stream surfaces when a tool needs
 * explicit approval (e.g. `shell.exec` that escapes the workspace). Three
 * design goals:
 *
 *   1. Make the action visible. Always show the tool, the reason, and a
 *      preview of what the tool would do. The user must NOT click Allow
 *      blind.
 *   2. Make Allow the primary action visually but require eyes-on intent —
 *      Allow is brand-coloured, Deny is a quiet ghost. Both share a 44pt
 *      tap target so neither is harder to hit accidentally than the other.
 *   3. Keyboard speed-path. Enter approves, Esc denies. Hint chips show
 *      the bindings so power users don't have to reach for the mouse.
 *
 * Tested by ApprovalCard.test.tsx — the visible button labels are kept as
 * "允许" / "拒绝" (single-token spans, separate from the kbd hint) so the
 * test keeps using `getByText("允许")` / `getByText("拒绝")` literally.
 */
export function ApprovalCard(props: ApprovalCardProps) {
  const previewText = useMemo(
    () => summarizeToolInput(props.tool, props.input, { full: true }),
    [props.tool, props.input],
  );
  const hasPreview = previewText.trim().length > 0;
  const allowRef = useRef<HTMLButtonElement | null>(null);
  const denyRef = useRef<HTMLButtonElement | null>(null);

  // Speed-path: focus moves to Allow on mount so Enter confirms; Esc denies.
  // We use a window listener (instead of onKeyDown on the card root) because
  // the user's hands may already be on the composer — the binding should be
  // global to the chat surface for as long as the card is mounted.
  useEffect(() => {
    if (props.submitting) return;
    allowRef.current?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      // Don't fight with composer / dialog handlers — only act on bare keys.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key === "Enter") {
        event.preventDefault();
        allowRef.current?.click();
      } else if (event.key === "Escape") {
        event.preventDefault();
        denyRef.current?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.submitting]);

  return (
    <aside
      className="approval-card"
      role="alertdialog"
      aria-labelledby={`approval-title-${props.callId}`}
      aria-describedby={`approval-reason-${props.callId}`}
    >
      <header className="approval-card-header">
        <span className="approval-card-icon" aria-hidden="true">
          <ShieldIcon />
        </span>
        <div className="approval-card-meta">
          <strong id={`approval-title-${props.callId}`}>需要批准</strong>
          <code className="approval-card-tool">{props.tool}</code>
        </div>
        <RiskChip tool={props.tool} />
      </header>

      {props.reason ? (
        <p
          id={`approval-reason-${props.callId}`}
          className="approval-card-reason"
        >
          {props.reason}
        </p>
      ) : null}

      {hasPreview ? <ToolInputPreview text={previewText} /> : null}

      <div
        className={
          "approval-card-actions" +
          (props.submitting ? " is-submitting" : "")
        }
      >
        <button
          ref={denyRef}
          type="button"
          className="approval-card-deny"
          aria-label="拒绝"
          onClick={() => props.onDecide(props.callId, "deny")}
          disabled={props.submitting}
          aria-busy={props.submitting}
        >
          {/* Keep the label + kbd hint mounted while submitting so the
           * button width doesn't jump; instead show a small spinner
           * over the content. The kbd stays under the spinner — the
           * label/spinner cross-fade via opacity, not display, so the
           * whole row stays at its resting size. The button's
           * aria-label keeps the accessible name stable regardless of
           * the inner cross-fade. */}
          <span className="approval-card-action-content">
            <span className="approval-card-action-label">拒绝</span>
            <kbd className="approval-card-kbd" aria-hidden="true">Esc</kbd>
          </span>
          {props.submitting ? (
            <span className="approval-card-action-spinner" aria-hidden="true">
              <ActionSpinner />
            </span>
          ) : null}
        </button>
        <button
          ref={allowRef}
          type="button"
          className="approval-card-allow"
          aria-label="允许"
          onClick={() => props.onDecide(props.callId, "allow")}
          disabled={props.submitting}
          aria-busy={props.submitting}
        >
          <span className="approval-card-action-content">
            <span className="approval-card-action-label">允许</span>
            <kbd className="approval-card-kbd" aria-hidden="true">⏎</kbd>
          </span>
          {props.submitting ? (
            <span className="approval-card-action-spinner" aria-hidden="true">
              <ActionSpinner />
            </span>
          ) : null}
        </button>
      </div>
    </aside>
  );
}

/**
 * Single-line risk hint based on a tool-name heuristic. The gateway may
 * pass a real risk level later; until then we encode the most common
 * sensitive surface (shell + writes that escape workspace) as a chip.
 */
function RiskChip({ tool }: { tool: string }) {
  const lvl = riskLevelFor(tool);
  if (lvl === "low") return null;
  return (
    <span
      className={`approval-card-risk approval-card-risk-${lvl}`}
      aria-label={`风险等级 ${lvl}`}
    >
      {lvl === "high" ? "高风险" : "敏感操作"}
    </span>
  );
}

function riskLevelFor(tool: string): "low" | "medium" | "high" {
  if (tool === "shell.exec" || tool === "shell") return "high";
  if (tool.startsWith("file.write") || tool.startsWith("write")) return "medium";
  return "low";
}

/**
 * Read-only code preview of the tool input. Keeps the whole payload
 * available behind a "查看完整" reveal so a long argv doesn't dominate
 * the card by default. We start collapsed when the preview is long.
 */
function ToolInputPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(text.length <= 220);
  const isClipped = text.length > 220 && !expanded;
  const visible = isClipped ? text.slice(0, 220) : text;
  return (
    <div className="approval-card-preview">
      <span className="approval-card-preview-label">调用参数</span>
      <pre className="approval-card-preview-body">
        <code>{visible}</code>
        {isClipped ? <span className="approval-card-preview-fade">…</span> : null}
      </pre>
      {text.length > 220 ? (
        <button
          type="button"
          className="approval-card-preview-toggle"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "收起" : "查看完整"}
        </button>
      ) : null}
    </div>
  );
}

function ActionSpinner() {
  // 14px ring spinner that matches the kbd glyph height so it slots
  // visually where the kbd hint sits when idle. Pure CSS animation;
  // honours prefers-reduced-motion via the .approval-card-action-spinner rule.
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" opacity="0.25" />
      <path d="M14 8a6 6 0 0 1-6 6" />
    </svg>
  );
}

function ShieldIcon() {
  // Lucide-style shield-check at 14px — readable as a "this is gated"
  // affordance without screaming "warning" (the tone is "review", not
  // "danger"). Stroke width matches other 14×14 inline icons.
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.6l5.2 1.7v4.5c0 3.2-2.2 5.6-5.2 6.6-3-1-5.2-3.4-5.2-6.6V3.3L8 1.6z" />
      <path d="M5.6 8.1l1.7 1.7L10.5 6.6" />
    </svg>
  );
}
