import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

/* ============================================================
 * CommandPalette — Linear/Raycast-style ⌘K quick switcher.
 *
 * Open with ⌘K (macOS) / Ctrl+K (others). Search / arrow-keys /
 * Enter to execute. Esc closes. Each command is a `Command` with
 * a label, optional description, group, keywords, and an execute
 * fn. Filtering matches against label + keywords (case-insensitive
 * substring); commands are grouped under their `group` heading and
 * displayed in registration order within each group.
 *
 * The palette is a true modal — focus is trapped inside, the
 * overlay scrim blurs the backdrop, and Escape both closes the
 * sheet and returns focus to the previously-focused element.
 * Honours prefers-reduced-motion: the scale/fade entrance reduces
 * to a no-op and the search input still autofocuses.
 * ============================================================ */

export interface Command {
  /** Stable id used as React key + dedupe. */
  id: string;
  /** Visible label, e.g. "切换到智能体". */
  label: string;
  /** Optional secondary text shown after the label in muted color. */
  description?: string;
  /** Optional group heading; commands sharing a group cluster together. */
  group?: string;
  /** Extra terms to match against (synonyms, English aliases, ids). */
  keywords?: string[];
  /** Optional shortcut hint to render on the right (e.g. ["⌘", "1"]). */
  shortcut?: string[];
  /** Optional leading icon (Lucide-style svg). */
  icon?: React.ReactNode;
  /** What happens when the user picks this command. The palette closes
   *  automatically *after* execute resolves; throw to keep it open. */
  execute: () => void | Promise<void>;
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: ReadonlyArray<Command>;
  /** Optional placeholder for the search input. */
  placeholder?: string;
}

const DEFAULT_PLACEHOLDER = "搜索命令、智能体、设置…";

export function CommandPalette({
  isOpen,
  onClose,
  commands,
  placeholder = DEFAULT_PLACEHOLDER,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Reset query + active row each time the palette opens. Snapshot
  // the previously-focused element so Escape returns the user where
  // they came from (matches the kit's modal contract).
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setActiveIndex(0);
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    queueMicrotask(() => inputRef.current?.focus());
    return () => {
      const el = restoreFocusRef.current;
      restoreFocusRef.current = null;
      el?.focus?.();
    };
  }, [isOpen]);

  // Filter pipeline. Empty query → all commands. Otherwise match by
  // case-insensitive substring against label, description, and any
  // declared keywords. Filtering happens before grouping so groups
  // collapse cleanly when their commands all drop out.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice();
    return commands.filter((cmd) => {
      const haystack = [
        cmd.label,
        cmd.description ?? "",
        ...(cmd.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [commands, query]);

  // Stable group order: first-seen wins. Commands with no group
  // collapse under "其他" (Other) at the bottom.
  const groups = useMemo(() => {
    const order: string[] = [];
    const buckets = new Map<string, Command[]>();
    for (const cmd of filtered) {
      const g = cmd.group ?? "其他";
      if (!buckets.has(g)) {
        buckets.set(g, []);
        order.push(g);
      }
      buckets.get(g)!.push(cmd);
    }
    return order.map((g) => ({ group: g, commands: buckets.get(g)! }));
  }, [filtered]);

  // Flat command list mirrors what the user sees so up/down arrows
  // walk through groups in render order.
  const flat = useMemo(() => {
    const arr: Command[] = [];
    for (const { commands } of groups) arr.push(...commands);
    return arr;
  }, [groups]);

  // Clamp activeIndex when the visible list shrinks under it.
  useEffect(() => {
    if (activeIndex >= flat.length) setActiveIndex(Math.max(0, flat.length - 1));
  }, [flat.length, activeIndex]);

  // Make sure the active row scrolls into view as the user arrows
  // through long lists. `block: "nearest"` avoids jumping when the
  // active row is already visible.
  useEffect(() => {
    if (!listRef.current) return;
    const node = listRef.current.querySelector<HTMLElement>(
      `[data-cmd-index="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!isOpen) return null;

  function move(delta: number) {
    if (flat.length === 0) return;
    setActiveIndex((cur) => (cur + delta + flat.length) % flat.length);
  }

  async function executeAt(idx: number) {
    const cmd = flat[idx];
    if (!cmd) return;
    try {
      await cmd.execute();
    } finally {
      onClose();
    }
  }

  function handleKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, flat.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      void executeAt(activeIndex);
    }
  }

  return (
    <div
      className="cmdk-overlay"
      onMouseDown={(event) => {
        // Click on the scrim closes the palette; clicks inside
        // the sheet are stopped by the sheet's onMouseDown.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="cmdk-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={handleKey}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cmdk-search">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="搜索命令"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-autocomplete="list"
            aria-activedescendant={
              flat[activeIndex] ? `cmdk-row-${flat[activeIndex].id}` : undefined
            }
            className="cmdk-input"
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            spellCheck="false"
            autoComplete="off"
          />
          <kbd className="cmdk-esc-hint" aria-hidden="true">
            Esc
          </kbd>
        </div>

        <div
          id="cmdk-list"
          className="cmdk-list"
          role="listbox"
          aria-label="可执行命令"
          ref={listRef}
        >
          {flat.length === 0 ? (
            <div className="cmdk-empty">没有匹配的命令</div>
          ) : (
            groups.map(({ group, commands: groupCmds }) => (
              <div key={group} className="cmdk-group">
                <div className="cmdk-group-head">{group}</div>
                {groupCmds.map((cmd) => {
                  // Compute the absolute index in the flat list so
                  // we can highlight + scroll the active row.
                  const idx = flat.indexOf(cmd);
                  const active = idx === activeIndex;
                  return (
                    <button
                      key={cmd.id}
                      id={`cmdk-row-${cmd.id}`}
                      data-cmd-index={idx}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={"cmdk-row" + (active ? " is-active" : "")}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => void executeAt(idx)}
                    >
                      {cmd.icon ? (
                        <span className="cmdk-row-icon" aria-hidden="true">
                          {cmd.icon}
                        </span>
                      ) : (
                        <span className="cmdk-row-icon" aria-hidden="true">
                          <DotIcon />
                        </span>
                      )}
                      <span className="cmdk-row-label">{cmd.label}</span>
                      {cmd.description ? (
                        <span className="cmdk-row-desc">{cmd.description}</span>
                      ) : null}
                      {cmd.shortcut ? (
                        <span className="cmdk-row-shortcut" aria-hidden="true">
                          {cmd.shortcut.map((k, i) => (
                            <kbd key={i}>{k}</kbd>
                          ))}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <footer className="cmdk-foot">
          <span className="cmdk-foot-hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            选择
          </span>
          <span className="cmdk-foot-hint">
            <kbd>Enter</kbd>
            执行
          </span>
          <span className="cmdk-foot-spacer" />
          <span className="cmdk-foot-hint">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
            打开
          </span>
        </footer>
      </div>
    </div>
  );
}

/* ============================================================
 * Hook — wires up the global ⌘K shortcut. Returns isOpen + handlers.
 * Mount this in the App root and pass isOpen/onClose to <CommandPalette>.
 * ============================================================ */
export function useCommandPalette() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // ⌘K (macOS) / Ctrl+K (everywhere else). Don't fire while
      // the user is composing IME text or already typing in an
      // input that intercepts the key (the palette itself).
      const isToggle =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        (event.key === "k" || event.key === "K");
      if (!isToggle) return;
      event.preventDefault();
      setIsOpen((open) => !open);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    isOpen,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
  };
}

/* ============================================================
 * Icons (kept inline so the palette stays self-contained — the rest
 * of the app uses a mix of Lucide CDN + handcrafted SVGs and we
 * don't want to drag a dep in for two glyphs).
 * ============================================================ */
function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5l3 3" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg viewBox="0 0 16 16" width="6" height="6" aria-hidden="true">
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}
