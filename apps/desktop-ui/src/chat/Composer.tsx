import * as React from "react";
import { useEffect, useRef, useState } from "react";

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
        <AgentPicker
          agents={props.agents}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={props.onSelectAgent}
        />
        <div className="thinking-segmented" role="radiogroup" aria-label="思考模式">
          {THINKING_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={option.value === thinking}
              className={"thinking-segment" + (option.value === thinking ? " active" : "")}
              onClick={() => setThinking(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
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

interface AgentPickerProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
}

function AgentPicker({ agents, selectedAgentId, onSelectAgent }: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Fall back to the first available agent so the trigger always shows a
  // concrete name once the agent list has loaded (matches the historical
  // <select> behaviour where an empty value displayed the first option).
  const selectedAgent =
    agents.find((a) => a.id === selectedAgentId) ?? agents[0] ?? null;
  const triggerLabel = selectedAgent?.name ?? "选择智能体";

  function closeAndReturnFocus() {
    setOpen(false);
    setFocusedIndex(-1);
    triggerRef.current?.focus();
  }

  // Close on Escape and on outside click. Window-level so the menu closes
  // when clicking elsewhere in the page (titlebar, message list, etc.).
  // Outside-click closes WITHOUT returning focus (the user moved their
  // attention elsewhere) — Escape always returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndReturnFocus();
      }
    }
    function onMouseDown(event: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
      setFocusedIndex(-1);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  // When the menu opens, move focus into it: the active row if any,
  // otherwise the first item. This is the WAI-ARIA expectation for menus.
  useEffect(() => {
    if (!open) return;
    const activeIdx = agents.findIndex((a) => a.id === selectedAgent?.id);
    const initial = activeIdx >= 0 ? activeIdx : 0;
    setFocusedIndex(initial);
    queueMicrotask(() => itemRefs.current[initial]?.focus());
  }, [open, agents, selectedAgent?.id]);

  function handleSelect(id: string) {
    onSelectAgent(id);
    closeAndReturnFocus();
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (agents.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = (focusedIndex + 1) % agents.length;
      setFocusedIndex(next);
      itemRefs.current[next]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = focusedIndex <= 0 ? agents.length - 1 : focusedIndex - 1;
      setFocusedIndex(prev);
      itemRefs.current[prev]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      setFocusedIndex(0);
      itemRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const last = agents.length - 1;
      setFocusedIndex(last);
      itemRefs.current[last]?.focus();
    }
  }

  return (
    <div className="agent-picker" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="agent-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`智能体: ${triggerLabel}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-picker-name">{triggerLabel}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <div
          className="agent-picker-menu"
          role="menu"
          aria-label="智能体"
          onKeyDown={handleMenuKeyDown}
        >
          {agents.map((agent, idx) => {
            const isActive = agent.id === selectedAgent?.id;
            return (
              <button
                key={agent.id}
                ref={(node) => {
                  itemRefs.current[idx] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                tabIndex={idx === focusedIndex ? 0 : -1}
                className={"agent-picker-item" + (isActive ? " active" : "")}
                onClick={() => handleSelect(agent.id)}
              >
                <span className="agent-picker-item-name">{agent.name}</span>
                {isActive ? <CheckIcon /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ChevronIcon() {
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
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
