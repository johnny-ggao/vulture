import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, type BadgeTone } from "./components";
import { summarizeToolInput } from "./toolPresentation";

export type ToolBlockStatus = "planned" | "running" | "completed" | "failed";

export interface ToolBlockProps {
  callId: string;
  tool: string;
  input: unknown;
  status: ToolBlockStatus;
  output?: unknown;
  error?: { code: string; message: string };
}

const HEADER_PREVIEW_MAX = 64;
const BODY_TEXT_MAX_LINES = 24;

/**
 * One row in the tool chain. Header is always-visible with: chevron,
 * tool name, one-line input preview, and a status badge that animates
 * for the running state. Body shows full input + output (or error)
 * with Copy affordances and a max-height scroll so a 5kB stdout can't
 * push the next message off-screen.
 *
 * Auto-expansion rules: running and failed states open by default so
 * the user sees what's happening / what went wrong; planned and
 * completed states stay collapsed unless toggled. Manual toggles
 * stick (we don't fight the user when status changes).
 */
export function ToolBlock(props: ToolBlockProps) {
  const defaultExpanded = props.status === "running" || props.status === "failed";
  const [manuallyToggled, setManuallyToggled] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const open = manuallyToggled ? expanded : defaultExpanded;

  const headerPreview = useMemo(
    () => clip(summarizeToolInput(props.tool, props.input), HEADER_PREVIEW_MAX),
    [props.tool, props.input],
  );
  const fullInput = useMemo(
    () => summarizeToolInput(props.tool, props.input, { full: true }),
    [props.tool, props.input],
  );
  const fullOutput = useMemo(
    () => formatToolOutput(props.output),
    [props.output],
  );

  const statusLabel = labelFor(props.status);
  const statusTone = toneFor(props.status);

  return (
    <div
      className={`tool-block tool-block-${props.status}`}
      data-tool={props.tool}
    >
      <button
        type="button"
        className="tool-block-header"
        aria-expanded={open}
        onClick={() => {
          setManuallyToggled(true);
          setExpanded((e) => !e);
        }}
      >
        <span className="tool-block-chevron" aria-hidden="true">
          <ChevronIcon open={open} />
        </span>
        <ToolGlyph tool={props.tool} />
        <strong className="tool-block-tool">{props.tool}</strong>
        {headerPreview ? (
          <code className="tool-block-input">{headerPreview}</code>
        ) : null}
        <span className="tool-block-status">
          {props.status === "running" ? (
            <span className="tool-block-spinner" aria-hidden="true" />
          ) : null}
          <Badge tone={statusTone}>{statusLabel}</Badge>
        </span>
      </button>

      {open ? (
        <div className="tool-block-body">
          {fullInput ? (
            <ToolBlockSection label="调用参数" copyValue={fullInput}>
              <ScrollPre>{fullInput}</ScrollPre>
            </ToolBlockSection>
          ) : null}

          {props.output !== undefined ? (
            <ToolBlockSection label="返回" copyValue={fullOutput}>
              <ScrollPre>{fullOutput}</ScrollPre>
            </ToolBlockSection>
          ) : null}

          {props.error ? (
            <ToolBlockSection
              label={`错误 · ${props.error.code}`}
              variant="error"
              copyValue={props.error.message}
            >
              <ScrollPre>{props.error.message}</ScrollPre>
            </ToolBlockSection>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface ToolBlockSectionProps {
  label: string;
  variant?: "default" | "error";
  copyValue: string;
  children: React.ReactNode;
}

function ToolBlockSection({
  label,
  variant = "default",
  copyValue,
  children,
}: ToolBlockSectionProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy() {
    if (!copyValue) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyValue);
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write may fail in restricted contexts (e.g. Tauri without
      // permission); silently swallow — the visual state stays "not copied".
    }
  }

  return (
    <section className={`tool-block-section tool-block-section-${variant}`}>
      <header className="tool-block-section-head">
        <span className="tool-block-section-label">{label}</span>
        <button
          type="button"
          className="tool-block-copy"
          onClick={copy}
          aria-label={`复制${label}`}
          data-copied={copied || undefined}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </header>
      {children}
    </section>
  );
}

/**
 * Pre block with a max-height clamp — anything over `BODY_TEXT_MAX_LINES`
 * scrolls within the section instead of pushing later messages off-screen.
 * The body itself is selectable and tab-focusable for keyboard scroll.
 */
function ScrollPre({ children }: { children: React.ReactNode }) {
  return (
    <pre
      className="tool-block-pre"
      tabIndex={0}
      style={{ "--max-lines": BODY_TEXT_MAX_LINES } as React.CSSProperties}
    >
      <code>{children}</code>
    </pre>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  // Single icon that rotates via CSS transform — avoids a flash when
  // toggling between two distinct paths.
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 160ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}
    >
      <path d="M5.5 3l5 5-5 5" />
    </svg>
  );
}

/**
 * Per-tool glyph in the header. Falls back to a generic dotted-square
 * for unknown tools so every row has visual rhythm. SVG only — no
 * emojis, per the project icon discipline.
 */
function ToolGlyph({ tool }: { tool: string }) {
  const family = familyOf(tool);
  return (
    <span
      className={`tool-block-glyph tool-block-glyph-${family}`}
      aria-hidden="true"
    >
      {family === "shell" ? <ShellIcon /> : null}
      {family === "file" ? <FileIcon /> : null}
      {family === "web" ? <WebIcon /> : null}
      {family === "generic" ? <DotIcon /> : null}
    </span>
  );
}

function familyOf(tool: string): "shell" | "file" | "web" | "generic" {
  if (tool === "shell" || tool === "shell.exec" || tool.endsWith(".exec")) return "shell";
  if (tool.startsWith("file") || tool === "read" || tool === "write") return "file";
  if (tool.startsWith("web") || tool.startsWith("fetch") || tool.startsWith("http")) return "web";
  return "generic";
}

function ShellIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4l3 3-3 3" />
      <path d="M8 11h5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9 2.5v3h3" />
    </svg>
  );
}

function WebIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <path d="M8 2.5c2 1.6 2 9.4 0 11" />
      <path d="M8 2.5c-2 1.6-2 9.4 0 11" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true">
      <circle cx="4" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="12" cy="8" r="1.4" />
    </svg>
  );
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatToolOutput(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    const stdout = typeof obj.stdout === "string" ? obj.stdout : "";
    const stderr = typeof obj.stderr === "string" ? obj.stderr : "";
    if (stdout || stderr) {
      const exit =
        typeof obj.exitCode === "number" ? `\n[exit ${obj.exitCode}]` : "";
      const stderrBlock = stderr ? `\n[stderr]\n${stderr}` : "";
      return `${stdout}${stderrBlock}${exit}`.trim();
    }
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function labelFor(status: ToolBlockStatus): string {
  switch (status) {
    case "planned":
      return "排队中";
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
  }
}

function toneFor(status: ToolBlockStatus): BadgeTone {
  switch (status) {
    case "running":
      return "info";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "planned":
    default:
      return "neutral";
  }
}
