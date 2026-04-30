import { useState } from "react";
import { Badge, type BadgeTone } from "./components";

export type ToolBlockStatus = "planned" | "running" | "completed" | "failed";

export interface ToolBlockProps {
  callId: string;
  tool: string;
  input: unknown;
  status: ToolBlockStatus;
  output?: unknown;
  error?: { code: string; message: string };
}

export function ToolBlock(props: ToolBlockProps) {
  const defaultExpanded = props.status === "running" || props.status === "failed";
  const [manuallyToggled, setManuallyToggled] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const open = manuallyToggled ? expanded : defaultExpanded;

  const inputSummary = summarize(props.input);
  const statusLabel = labelFor(props.status);
  const statusTone = toneFor(props.status);

  return (
    <div className={`tool-block tool-block-${props.status}`}>
      <button
        type="button"
        className="tool-block-header"
        onClick={() => {
          setManuallyToggled(true);
          setExpanded((e) => !e);
        }}
      >
        <span className="tool-block-icon">{open ? "▼" : "▶"}</span>
        <strong className="tool-block-tool">{props.tool}</strong>
        <code className="tool-block-input">{inputSummary}</code>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </button>
      {open ? (
        <div className="tool-block-body">
          <div className="tool-block-input-full">
            <span className="label">Input</span>
            <pre>{JSON.stringify(props.input, null, 2)}</pre>
          </div>
          {props.output !== undefined ? (
            <div className="tool-block-output">
              <span className="label">Output</span>
              <pre>{JSON.stringify(props.output, null, 2)}</pre>
            </div>
          ) : null}
          {props.error ? (
            <div className="tool-block-error">
              <span className="label">Error ({props.error.code})</span>
              <pre>{props.error.message}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function summarize(input: unknown): string {
  if (input && typeof input === "object" && "argv" in input) {
    const argv = (input as { argv?: unknown }).argv;
    if (Array.isArray(argv)) return argv.map(String).join(" ");
  }
  return JSON.stringify(input).slice(0, 60);
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
