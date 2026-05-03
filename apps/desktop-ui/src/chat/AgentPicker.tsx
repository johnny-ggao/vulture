import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { AgentAvatar } from "./components";

export interface AgentPickerProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
}

/**
 * Compact menu for switching the active agent. Lives in ChatView's
 * new-conversation hero (under the agent glyph) — agent switching is a
 * decision you make BEFORE starting a thread, not mid-conversation, so
 * the chip never appears next to the composer once messages exist.
 */
export function AgentPicker({ agents, selectedAgentId, onSelectAgent }: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedAgent =
    agents.find((a) => a.id === selectedAgentId) ?? agents[0] ?? null;
  const triggerLabel = selectedAgent?.name ?? "选择智能体";

  function closeAndReturnFocus() {
    setOpen(false);
    setFocusedIndex(-1);
    triggerRef.current?.focus();
  }

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
        aria-label={`切换智能体: ${triggerLabel}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-picker-name">切换智能体</span>
        <ChevronDownIcon />
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
                <AgentAvatar agent={agent} size={24} shape="square" />
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

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7.5l3 3 5-6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
