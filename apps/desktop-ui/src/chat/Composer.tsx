import { useState } from "react";

export interface ComposerProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  running: boolean;
  onSend: (input: string) => void;
  onCancel: () => void;
}

export function Composer(props: ComposerProps) {
  const [value, setValue] = useState("");

  function send() {
    const trimmed = value.trim();
    if (!trimmed || props.running) return;
    props.onSend(trimmed);
    setValue("");
  }

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
      <div className="composer-controls">
        <select
          value={props.selectedAgentId}
          onChange={(e) => props.onSelectAgent(e.target.value)}
        >
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {props.running ? (
          <button
            type="button"
            className="composer-cancel"
            aria-label="取消"
            onClick={props.onCancel}
          >
            ⏹
          </button>
        ) : (
          <button
            type="button"
            className="composer-send"
            aria-label="发送"
            onClick={send}
            disabled={!value.trim()}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
