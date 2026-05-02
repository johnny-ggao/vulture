import * as React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConversationPermissionMode } from "../api/conversations";
import { AgentAvatar } from "./components";

export type ThinkingMode = "low" | "medium" | "high";

const THINKING_OPTIONS: Array<{ value: ThinkingMode; label: string }> = [
  { value: "low", label: "快速" },
  { value: "medium", label: "标准" },
  { value: "high", label: "深度" },
];

const PERMISSION_OPTIONS: Array<{ value: ConversationPermissionMode; label: string }> = [
  { value: "default", label: "默认权限" },
  { value: "read_only", label: "只读" },
  { value: "auto_review", label: "智能审批" },
  { value: "full_access", label: "整机完全权限" },
];

const TEXTAREA_MIN_HEIGHT = 56;
const TEXTAREA_MAX_HEIGHT = 280;

export interface ComposerProps {
  agents: ReadonlyArray<{ id: string; name: string }>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  permissionMode?: ConversationPermissionMode;
  onChangePermissionMode?: (mode: ConversationPermissionMode) => void | Promise<void>;
  running: boolean;
  onSend: (input: string, files: File[]) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
}

export function Composer(props: ComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [thinking, setThinking] = useState<ThinkingMode>("low");
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow: clamp the textarea between MIN and MAX heights based on
  // the content's scrollHeight. We reset to "auto" first so shrinking
  // works after the user deletes lines (otherwise scrollHeight stays at
  // the previous tall value). useLayoutEffect (not useEffect) so the
  // user never sees the unsized intermediate state.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(
      Math.max(ta.scrollHeight, TEXTAREA_MIN_HEIGHT),
      TEXTAREA_MAX_HEIGHT,
    );
    ta.style.height = `${next}px`;
  }, [value]);

  // Auto-focus the composer once on mount — every desktop chat client
  // (Claude, ChatGPT, Linear) lands the cursor here so the user can
  // start typing immediately. Skip if focus already lives in another
  // input (rare but possible if the parent renders a header field).
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const active = document.activeElement;
    const isInputFocused =
      active instanceof HTMLElement &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable);
    if (isInputFocused) return;
    ta.focus({ preventScroll: true });
  }, []);

  async function send() {
    const trimmed = value.trim();
    if (!trimmed || props.running || !props.selectedAgentId) return;
    const result = await props.onSend(trimmed, files);
    if (result === false) return;
    setValue("");
    setFiles([]);
  }

  function appendFiles(next: ReadonlyArray<File>) {
    if (next.length === 0) return;
    setFiles((prev) => {
      // De-dupe by (name, size) — picking the same file twice from the
      // OS dialog produces two identical File objects, which the user
      // doesn't expect to upload twice.
      const seen = new Set(prev.map((f) => `${f.name}::${f.size}`));
      const fresh = Array.from(next).filter(
        (f) => !seen.has(`${f.name}::${f.size}`),
      );
      return prev.concat(fresh);
    });
  }

  function removeFile(target: File) {
    setFiles((prev) =>
      prev.filter((f) => f.name !== target.name || f.size !== target.size),
    );
  }

  // Drag-and-drop attachments. The drag overlay only shows while the
  // pointer is inside the composer; we track entry/leave at the root
  // element to avoid the flicker that comes from individual children
  // firing dragleave as the cursor moves over them.
  const dragDepth = useRef(0);
  function onDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragLeave(event: React.DragEvent<HTMLDivElement>) {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
    event.preventDefault();
  }
  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
  }
  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    appendFiles(Array.from(event.dataTransfer.files));
  }

  const canSend = Boolean(value.trim() && props.selectedAgentId && !props.running);
  const permissionMode = props.permissionMode ?? "default";

  return (
    <div
      className={"composer" + (dragging ? " composer-dragging" : "")}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
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
            <AttachmentChip
              key={`${file.name}::${file.size}`}
              file={file}
              onRemove={() => removeFile(file)}
            />
          ))}
        </div>
      ) : null}
      <div className="composer-controls">
        <AgentPicker
          agents={props.agents}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={props.onSelectAgent}
        />
        <ChipPopover<ConversationPermissionMode>
          ariaLabel="工具权限"
          icon={<ShieldIcon />}
          options={PERMISSION_OPTIONS}
          value={permissionMode}
          onChange={(v) => { void props.onChangePermissionMode?.(v); }}
        />
        <ChipPopover<ThinkingMode>
          ariaLabel="思考模式"
          icon={<BrainIcon />}
          options={THINKING_OPTIONS}
          value={thinking}
          onChange={setThinking}
        />
        <label className="composer-attach" title="添加附件">
          <input
            type="file"
            multiple
            aria-label="添加附件"
            onChange={(e) => {
              appendFiles(Array.from(e.currentTarget.files ?? []));
              // Reset the file input so picking the same file twice in a
              // row still fires onChange (browsers debounce identical
              // selections by default).
              e.currentTarget.value = "";
            }}
          />
          <PaperclipIcon />
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

      {dragging ? (
        <div className="composer-dropzone" aria-hidden="true">
          <div className="composer-dropzone-card">
            <DropIcon />
            <span>松开以添加附件</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface AttachmentChipProps {
  file: File;
  onRemove: () => void;
}

function AttachmentChip({ file, onRemove }: AttachmentChipProps) {
  const isImage = file.type.startsWith("image/");
  return (
    <span
      className={`composer-attachment composer-attachment-${isImage ? "image" : "file"}`}
    >
      <span className="composer-attachment-icon" aria-hidden="true">
        {isImage ? <ImageIcon /> : <FileIcon />}
      </span>
      <span className="composer-attachment-name">{file.name}</span>
      <em className="composer-attachment-size">{formatBytes(file.size)}</em>
      <button
        type="button"
        className="composer-attachment-remove"
        aria-label={`移除 ${file.name}`}
        onClick={onRemove}
      >
        <CloseSmallIcon />
      </button>
    </span>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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

interface ChipPopoverOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

interface ChipPopoverProps<V extends string> {
  ariaLabel: string;
  icon?: React.ReactNode;
  options: ReadonlyArray<ChipPopoverOption<V>>;
  value: V;
  onChange: (value: V) => void;
}

function ChipPopover<V extends string>({
  ariaLabel,
  icon,
  options,
  value,
  onChange,
}: ChipPopoverProps<V>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onMouseDown(event: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
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
    const idx = Math.max(0, options.findIndex((o) => o.value === value));
    queueMicrotask(() => itemRefs.current[idx]?.focus());
  }, [open, options, value]);

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (options.length === 0) return;
    const focused = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = focused < 0 ? 0 : (focused + 1) % options.length;
      itemRefs.current[next]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = focused <= 0 ? options.length - 1 : focused - 1;
      itemRefs.current[prev]?.focus();
    }
  }

  return (
    <div className="chip-popover" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${current?.label ?? ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        {icon ? <span className="composer-chip-icon" aria-hidden="true">{icon}</span> : null}
        <span className="composer-chip-label">{current?.label ?? ""}</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div
          className="chip-popover-menu"
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={handleMenuKeyDown}
        >
          {options.map((option, idx) => {
            const isActive = option.value === value;
            return (
              <button
                key={option.value}
                ref={(node) => {
                  itemRefs.current[idx] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={"chip-popover-item" + (isActive ? " active" : "")}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span className="chip-popover-item-label">{option.label}</span>
                {option.hint ? (
                  <span className="chip-popover-item-hint">{option.hint}</span>
                ) : null}
                {isActive ? <CheckIcon /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5l5.5 2v4.2c0 3.4-2.4 6.2-5.5 7.3-3.1-1.1-5.5-3.9-5.5-7.3V3.5L8 1.5z" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.2a2 2 0 0 0-2 2v.4a2 2 0 0 0-1.5 1.9V8a2 2 0 0 0 1.5 1.9v.6a2 2 0 0 0 2 2c.6 0 1.1-.3 1.5-.7" />
      <path d="M10 3.2a2 2 0 0 1 2 2v.4a2 2 0 0 1 1.5 1.9V8a2 2 0 0 1-1.5 1.9v.6a2 2 0 0 1-2 2c-.6 0-1.1-.3-1.5-.7" />
      <path d="M8 3v9.8" />
    </svg>
  );
}

function ChevronDownIcon() {
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

function PaperclipIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path d="M13.5 7.5 8.1 12.9a3.2 3.2 0 0 1-4.5-4.5l5.8-5.8a2.2 2.2 0 0 1 3.1 3.1L6.6 11.6a1.2 1.2 0 0 1-1.7-1.7l5.4-5.4" />
    </svg>
  );
}

function CloseSmallIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M4 12l8-8" />
    </svg>
  );
}

function ImageIcon() {
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
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="M3 12l3-3 2.5 2.5L11 8l2 2" />
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
      aria-hidden="true"
    >
      <path d="M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9 2.5v3h3" />
    </svg>
  );
}

function DropIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V5" />
      <path d="M7 10l5-5 5 5" />
      <path d="M5 18.5h14" />
    </svg>
  );
}
