import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCoreFile } from "../../api/agents";
import { PERSONA_STARTERS } from "./personaStarters";

export interface CoreTabProps {
  files: AgentCoreFile[];
  selectedFile: string;
  onSelectFile: (name: string) => void;
  fileContent: string;
  onChangeFileContent: (next: string) => void;
  fileBusy: boolean;
  fileStatus: string;
  corePath: string;
  onSave: () => void;
}

/**
 * 核心文件 — Accio-style three-band editor for the agent's persona /
 * memory bundle.
 *
 *   ┌─ Header: title + Workspace path + 风格 menu (writes the chosen
 *   │          starter into AGENTS.md after a confirm) + 保存 button.
 *   ├─ File rail: AGENTS.md / memories.md tiles with size + missing
 *   │             state. Sticky on the left.
 *   └─ Editor: monospace textarea, fills the remaining space. Tab key
 *              inserts two spaces; Cmd/Ctrl+S saves.
 *
 * AGENTS.md is the canonical home for the agent's persona, so the
 * "风格" affordance lives here instead of on a dedicated rail tab —
 * picking a starter rewrites the AGENTS.md body inline so the user
 * can keep tweaking the result.
 */
export function CoreTab(props: CoreTabProps) {
  const isAgentsMd = props.selectedFile === "AGENTS.md";

  return (
    <div className="agent-config-panel" role="tabpanel">
      <section className="agent-core">
        <header className="agent-core-head">
          <div className="agent-core-head-text">
            <h3 className="agent-core-title">核心文件</h3>
            <p className="agent-core-sub">
              智能体的人格、记忆与行为规则都存放在这里；这些 markdown
              文件随智能体一起持久化。
            </p>
            {props.corePath ? (
              <code className="agent-core-path" title={props.corePath}>
                {props.corePath}
              </code>
            ) : null}
          </div>
          <div className="agent-core-head-actions">
            {isAgentsMd ? (
              <StyleApplyMenu
                onApply={(body) => props.onChangeFileContent(body)}
                disabled={props.fileBusy}
                hasContent={props.fileContent.trim().length > 0}
              />
            ) : null}
            <button
              type="button"
              className="btn-primary agent-core-save"
              disabled={!props.selectedFile || props.fileBusy}
              onClick={props.onSave}
            >
              {props.fileBusy ? (
                <>
                  <span
                    className="agent-edit-save-spinner"
                    aria-hidden="true"
                  />
                  保存中…
                </>
              ) : (
                "保存"
              )}
            </button>
          </div>
        </header>

        <div className="agent-core-body">
          <div className="agent-core-rail" role="tablist" aria-label="核心文件">
            {props.files.map((file) => {
              const active = file.name === props.selectedFile;
              return (
                <button
                  key={file.name}
                  type="button"
                  role="tab"
                  className="agent-core-file"
                  data-active={active ? "true" : undefined}
                  data-missing={file.missing ? "true" : undefined}
                  aria-selected={active}
                  onClick={() => props.onSelectFile(file.name)}
                  title={file.missing ? "文件未创建" : file.path}
                >
                  <span className="agent-core-file-icon" aria-hidden="true">
                    <FileGlyph name={file.name} />
                  </span>
                  <span className="agent-core-file-text">
                    <span className="agent-core-file-name">{file.name}</span>
                    <span className="agent-core-file-meta">
                      {file.missing
                        ? "未创建"
                        : describeFile(file.name, file.size)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="agent-core-editor-wrap">
            <textarea
              aria-label={`编辑 ${props.selectedFile || "核心文件"}`}
              className="agent-core-editor"
              value={props.fileContent}
              onChange={(e) => props.onChangeFileContent(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Tab" && !event.shiftKey) {
                  event.preventDefault();
                  insertAtCursor(
                    event.currentTarget,
                    "  ",
                    props.onChangeFileContent,
                  );
                }
              }}
              rows={16}
              spellCheck={false}
              disabled={!props.selectedFile || props.fileBusy}
              placeholder={
                isAgentsMd
                  ? "用「角色 → 目标 → 行为边界」的顺序写下智能体的人格定义。也可以从右上角「风格」中选取一个起点。"
                  : "选择左侧的文件开始编辑…"
              }
            />
            <div className="agent-core-editor-foot">
              <span className="agent-core-counter">
                {props.fileContent.length.toLocaleString("en-US")} 字符
              </span>
              {props.fileStatus ? (
                <span
                  className="agent-core-status"
                  role="status"
                  aria-live="polite"
                >
                  {props.fileStatus}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * 风格 menu — popover that lists persona starters. Clicking a
 * starter replaces the AGENTS.md body. When the file already
 * has content we ask first so the user can't lose work.
 * ============================================================ */
interface StyleApplyMenuProps {
  onApply: (body: string) => void;
  disabled: boolean;
  hasContent: boolean;
}

function StyleApplyMenu({ onApply, disabled, hasContent }: StyleApplyMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonId = useMemo(
    () => `agent-core-style-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Esc closes the menu and returns focus to the trigger so keyboard
  // users don't get stranded at document.body. Arrow keys cycle
  // through the menuitems while the menu is open.
  useEffect(() => {
    if (!open) return;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>(
      "[role='menuitem']",
    );
    firstItem?.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>(
            "[role='menuitem']",
          ) ?? [],
        );
        if (items.length === 0) return;
        const currentIdx = items.findIndex(
          (el) => el === document.activeElement,
        );
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIdx =
          currentIdx === -1
            ? 0
            : (currentIdx + delta + items.length) % items.length;
        event.preventDefault();
        items[nextIdx]?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function pick(starter: { label: string; body: string }) {
    if (hasContent) {
      const ok = window.confirm(
        `将 AGENTS.md 替换为「${starter.label}」起始模板？此操作不可撤销。`,
      );
      if (!ok) {
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }
    }
    onApply(starter.body);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="agent-core-style">
      <button
        type="button"
        ref={triggerRef}
        id={buttonId}
        className="btn-secondary btn-sm agent-core-style-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <SparklesIcon />
        <span>风格</span>
        <ChevronIcon />
      </button>
      {open ? (
        <>
          <div
            className="agent-core-style-scrim"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <div
            ref={menuRef}
            className="agent-core-style-menu"
            role="menu"
            aria-labelledby={buttonId}
          >
            <div className="agent-core-style-menu-head">
              选择一个人格风格作为起点，会写入 AGENTS.md
            </div>
            {PERSONA_STARTERS.map((starter) => (
              <button
                key={starter.label}
                type="button"
                role="menuitem"
                className="agent-core-style-item"
                onClick={() => pick(starter)}
              >
                <span className="agent-core-style-item-name">
                  {starter.label}
                </span>
                <span className="agent-core-style-item-snippet">
                  {firstLine(starter.body)}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.slice(0, 60);
}

function describeFile(name: string, size: number | undefined): string {
  const sizeLabel = formatFileSize(size);
  if (name === "AGENTS.md") return `人格 · ${sizeLabel}`;
  if (name === "memories.md") return `记忆 · ${sizeLabel}`;
  return sizeLabel;
}

/** Pretty-print a file size in B / KB / MB. */
function formatFileSize(size: number | undefined): string {
  if (typeof size !== "number" || size < 0) return "—";
  if (size === 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Insert `insertion` at the textarea's selection while preserving
 *  the caret position — used for the Tab → 2-space mapping. */
function insertAtCursor(
  textarea: HTMLTextAreaElement,
  insertion: string,
  onChange: (next: string) => void,
) {
  const { selectionStart, selectionEnd, value } = textarea;
  const next =
    value.slice(0, selectionStart) + insertion + value.slice(selectionEnd);
  onChange(next);
  requestAnimationFrame(() => {
    textarea.selectionStart = selectionStart + insertion.length;
    textarea.selectionEnd = selectionStart + insertion.length;
  });
}

function FileGlyph({ name }: { name: string }) {
  if (name === "AGENTS.md") {
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
        <circle cx="8" cy="6" r="2.5" />
        <path d="M3 13c.5-2.5 2.7-4 5-4s4.5 1.5 5 4" />
      </svg>
    );
  }
  if (name === "memories.md") {
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
        <path d="M3 4.5v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-7" />
        <path d="M3 4.5h10M5 7h6M5 9.5h4" />
      </svg>
    );
  }
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
      <path d="M4 2.5h5L12.5 6v7a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" />
      <path d="M9 2.5V6h3.5" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.5l1.4 3 3 1.4-3 1.4-1.4 3-1.4-3-3-1.4 3-1.4Z" />
      <path d="M12.5 11l.7 1.4 1.4.7-1.4.7-.7 1.4-.7-1.4-1.4-.7 1.4-.7Z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
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
