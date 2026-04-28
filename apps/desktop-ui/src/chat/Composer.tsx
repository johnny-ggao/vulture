import { useState } from "react";

export type ThinkingMode = "low" | "medium" | "high";

const THINKING_OPTIONS: Array<{ value: ThinkingMode; label: string }> = [
  { value: "low", label: "快速" },
  { value: "medium", label: "标准" },
  { value: "high", label: "深度" },
];

export interface ComposerProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  running: boolean;
  onSend: (input: string, files: File[]) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
}

export function Composer(props: ComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [thinking, setThinking] = useState<ThinkingMode>("low");

  async function send() {
    const trimmed = value.trim();
    if (!trimmed || props.running || !props.selectedAgentId) return;
    const result = await props.onSend(trimmed, files);
    if (result === false) return;
    setValue("");
    setFiles([]);
  }

  function cycleThinking() {
    const idx = THINKING_OPTIONS.findIndex((o) => o.value === thinking);
    setThinking(THINKING_OPTIONS[(idx + 1) % THINKING_OPTIONS.length].value);
  }

  const thinkingLabel = THINKING_OPTIONS.find((o) => o.value === thinking)?.label ?? "快速";
  const canSend = Boolean(value.trim() && props.selectedAgentId && !props.running);

  return (
    <div className="composer">
      <textarea
        value={value}
        placeholder="输入问题…（Enter 发送，Shift+Enter 换行）"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      {files.length > 0 ? (
        <div className="composer-attachments">
          {files.map((file) => (
            <span key={`${file.name}-${file.size}`} className="composer-attachment">
              {file.name}
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-controls">
        <select
          className="agent-select"
          value={props.selectedAgentId}
          onChange={(e) => props.onSelectAgent(e.target.value)}
          aria-label="智能体"
        >
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="chip"
          onClick={cycleThinking}
          aria-label={`思考模式：${thinkingLabel}`}
          title={`思考模式：${thinkingLabel}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 4 17.5v-1A2.5 2.5 0 0 1 2 14v-1A2.5 2.5 0 0 1 4.5 10.5 2.5 2.5 0 0 1 7 8V6.5A2.5 2.5 0 0 1 9.5 4 2.5 2.5 0 0 1 9.5 2Z"/>
            <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 20 17.5v-1A2.5 2.5 0 0 0 22 14v-1a2.5 2.5 0 0 0-2.5-2.5A2.5 2.5 0 0 0 17 8V6.5A2.5 2.5 0 0 0 14.5 4Z"/>
          </svg>
          <span>{thinkingLabel}</span>
        </button>
        <label className="composer-attach" title="添加附件">
          <input
            type="file"
            multiple
            aria-label="添加附件"
            onChange={(e) => setFiles(Array.from(e.currentTarget.files ?? []))}
          />
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
            <path d="M13.5 7.5 8.1 12.9a3.2 3.2 0 0 1-4.5-4.5l5.8-5.8a2.2 2.2 0 0 1 3.1 3.1L6.6 11.6a1.2 1.2 0 0 1-1.7-1.7l5.4-5.4" />
          </svg>
        </label>
        <span className="spacer" />
        {props.running ? (
          <button
            type="button"
            className="composer-cancel"
            aria-label="取消"
            onClick={props.onCancel}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
          </button>
        ) : (
          <button
            type="button"
            className="composer-send"
            aria-label="发送"
            onClick={send}
            disabled={!canSend}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M8 13V3" /><path d="M3 8l5-5 5 5" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
