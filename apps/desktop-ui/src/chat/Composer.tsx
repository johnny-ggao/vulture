import * as React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConversationPermissionMode } from "../api/conversations";
import { FileMentionMenu } from "./FileMentionMenu";

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
  permissionMode?: ConversationPermissionMode;
  onChangePermissionMode?: (mode: ConversationPermissionMode) => void | Promise<void>;
  /**
   * Optional working-directory affordance. When provided the composer renders
   * a chip below the textarea showing the current directory's basename (or
   * "选择工作目录" when null). Clicking the chip should open a folder picker;
   * clicking a small × clears it. The Composer doesn't open the picker itself
   * — the parent owns the Tauri dialog integration.
   */
  workingDirectory?: string | null;
  onPickWorkingDirectory?: () => void | Promise<void>;
  onClearWorkingDirectory?: () => void | Promise<void>;
  /**
   * Loads the file list for the @-mention picker. Resolves to relative paths
   * under `workingDirectory`. Called lazily on first @ keystroke and cached
   * for the lifetime of the working-directory selection. When omitted (or the
   * working directory is null), the @-mention popover shows an empty state
   * pointing the user at the workspace chip.
   */
  onLoadWorkspaceFiles?: () => Promise<ReadonlyArray<string>>;
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

  // ⌘. — macOS standard "cancel current operation". Wired to the
  // composer's onCancel so the user can stop a streaming run from
  // anywhere on the page (no need to find the cancel button).
  // Active only while running so the keystroke stays free for
  // selection / cursor moves the rest of the time.
  useEffect(() => {
    if (!props.running) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "." || !(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      props.onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.running, props.onCancel]);

  async function send() {
    const trimmed = value.trim();
    if (!trimmed || props.running) return;
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

  const canSend = Boolean(value.trim() && !props.running);
  const permissionMode = props.permissionMode ?? "default";

  // ---- @-mention picker state ------------------------------------
  // mention.start is the index of the `@` in `value`; mention.query is
  // the substring between that `@` and the current caret. The mention is
  // open whenever this state is non-null. Caret tracking is fed by
  // selectionStart on the textarea events; we don't observe it on every
  // mousemove.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [files_workdir_cache, setFilesCache] = useState<{
    root: string;
    paths: ReadonlyArray<string>;
  } | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  const ensureFilesLoaded = useCallback(async () => {
    if (!props.workingDirectory) return;
    if (files_workdir_cache?.root === props.workingDirectory) return;
    if (!props.onLoadWorkspaceFiles) return;
    setFilesLoading(true);
    try {
      const paths = await props.onLoadWorkspaceFiles();
      setFilesCache({ root: props.workingDirectory, paths });
    } catch (cause) {
      console.error("@-mention file list failed", cause);
      setFilesCache({ root: props.workingDirectory, paths: [] });
    } finally {
      setFilesLoading(false);
    }
  }, [props.workingDirectory, files_workdir_cache, props.onLoadWorkspaceFiles]);

  // Recompute mention state from a (text, caret) pair. A mention is "active"
  // when the latest `@` before the caret is preceded by start-of-string or
  // whitespace, and contains no whitespace between itself and the caret.
  function deriveMention(text: string, caret: number): { start: number; query: string } | null {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) return null;
    const prevChar = at === 0 ? "" : before[at - 1] ?? "";
    if (prevChar !== "" && !/\s/.test(prevChar)) return null;
    const query = before.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { start: at, query };
  }

  function handleTextareaChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = event.target.value;
    setValue(next);
    const caret = event.target.selectionStart ?? next.length;
    const m = deriveMention(next, caret);
    setMention(m);
    if (m) void ensureFilesLoaded();
  }

  function handleTextareaKeyUp(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Arrow keys / Home / End move the caret without changing value, so we
    // need to refresh mention state on key-up too. Cheap.
    const ta = event.currentTarget;
    const caret = ta.selectionStart ?? ta.value.length;
    setMention(deriveMention(ta.value, caret));
  }

  function handleMentionPick(path: string) {
    const m = mention;
    if (!m) return;
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? value.length;
    const replaced =
      value.slice(0, m.start) + "@" + path + " " + value.slice(caret);
    setValue(replaced);
    setMention(null);
    queueMicrotask(() => {
      const tEl = textareaRef.current;
      if (!tEl) return;
      const newCaret = m.start + 1 + path.length + 1;
      tEl.focus();
      tEl.setSelectionRange(newCaret, newCaret);
    });
  }

  function closeMention() {
    setMention(null);
  }

  return (
    <div
      className={"composer" + (dragging ? " composer-dragging" : "")}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {mention ? (
        <FileMentionMenu
          query={mention.query}
          paths={files_workdir_cache?.paths ?? []}
          loading={filesLoading}
          noWorkspace={!props.workingDirectory}
          onPick={handleMentionPick}
          onClose={closeMention}
          onPickWorkingDirectory={props.onPickWorkingDirectory}
        />
      ) : null}
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder="输入问题…（Enter 发送，Shift+Enter 换行，@ 插入文件）"
        onChange={handleTextareaChange}
        onKeyUp={handleTextareaKeyUp}
        onClick={(e) => {
          const ta = e.currentTarget;
          const caret = ta.selectionStart ?? ta.value.length;
          setMention(deriveMention(ta.value, caret));
        }}
        onKeyDown={(e) => {
          // Don't intercept Enter while the mention menu is open — the menu
          // handles Enter / Tab globally. Only the plain "send" path remains.
          if (mention) return;
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
        {props.onPickWorkingDirectory ? (
          <WorkingDirectoryChip
            workingDirectory={props.workingDirectory ?? null}
            onPick={props.onPickWorkingDirectory}
            onClear={props.onClearWorkingDirectory}
          />
        ) : null}
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
            title="取消运行  ⌘ ."
            aria-keyshortcuts="Meta+Period Control+Period"
            onClick={props.onCancel}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>
          </button>
        ) : (
          <button
            type="button"
            className="composer-send"
            aria-label="发送"
            title="发送  Enter"
            aria-keyshortcuts="Enter"
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


interface WorkingDirectoryChipProps {
  workingDirectory: string | null;
  onPick: () => void | Promise<void>;
  onClear?: () => void | Promise<void>;
}

/**
 * Composer chip that shows the active per-conversation working directory
 * (basename only — full path lives in title) or "选择工作目录" when unset.
 * Click → parent opens the folder picker. The little × on the right clears
 * the override and falls back to the agent's bound workspace.
 */
function WorkingDirectoryChip({ workingDirectory, onPick, onClear }: WorkingDirectoryChipProps) {
  const label = workingDirectory ? basename(workingDirectory) : "选择工作目录";
  const titleText = workingDirectory ?? "尚未为本对话选择工作目录";
  return (
    <span className="composer-workdir-chip" title={titleText}>
      <button
        type="button"
        className="composer-workdir-trigger"
        aria-label={
          workingDirectory
            ? `当前工作目录: ${workingDirectory}（点击更换）`
            : "选择工作目录"
        }
        onClick={() => void onPick()}
      >
        <FolderIcon />
        <span className="composer-workdir-label">{label}</span>
      </button>
      {workingDirectory && onClear ? (
        <button
          type="button"
          className="composer-workdir-clear"
          aria-label="清除工作目录，回到智能体默认工作区"
          onClick={() => void onClear()}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

function basename(path: string): string {
  // Cross-platform basename — pick the last segment after / or \. Empty
  // trailing segments (path ending in a separator) collapse to the prior one.
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
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
