import { useEffect, useMemo, useRef, useState } from "react";

export interface FileMentionMenuProps {
  /** The query text the user has typed AFTER the `@` (empty when they just typed `@`). */
  query: string;
  /** Flat list of paths relative to the working directory. */
  paths: ReadonlyArray<string>;
  /** Truthy when files list isn't ready yet (initial fetch in flight). */
  loading?: boolean;
  /** Truthy when the parent has no working directory configured. */
  noWorkspace?: boolean;
  /**
   * Invoked when the user picks a path. The composer replaces the in-flight
   * `@query` with `@path` and re-focuses the textarea.
   */
  onPick: (path: string) => void;
  /** Close without inserting (Esc, click outside, empty list). */
  onClose: () => void;
  /** Called when the user clicks "选择工作目录" inside the empty state. */
  onPickWorkingDirectory?: () => void | Promise<void>;
}

const VISIBLE_LIMIT = 40;

/**
 * Inline autocomplete menu for the @-mention picker. Renders as a popover
 * above / below the composer textarea with a filtered list of file paths.
 * Keyboard:
 *  - ArrowDown / ArrowUp move selection
 *  - Enter / Tab pick the highlighted entry
 *  - Esc closes without inserting (parent removes the popover but leaves the
 *    typed `@<query>` so the user can keep typing as plain text).
 *
 * Filter strategy: case-insensitive substring on the full relative path.
 * A 40-row visible cap keeps render cheap; the count of total matches is
 * surfaced in the footer so the user knows narrow filters help.
 */
export function FileMentionMenu({
  query,
  paths,
  loading,
  noWorkspace,
  onPick,
  onClose,
  onPickWorkingDirectory,
}: FileMentionMenuProps) {
  const filtered = useMemo(() => filterPaths(paths, query), [paths, query]);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Reset highlighted to 0 whenever the filter changes — otherwise an out-of-
  // bounds cursor sticks past a typing burst that shrank the list.
  useEffect(() => {
    setHighlighted(0);
  }, [query, paths]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((h) => Math.max(0, h - 1));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const pick = filtered[highlighted];
        if (pick) {
          event.preventDefault();
          onPick(pick);
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filtered, highlighted, onPick, onClose]);

  // Outside-click closes (cheap UX courtesy — the keyboard path covers Esc).
  useEffect(() => {
    function onMouseDown(event: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      onClose();
    }
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  if (noWorkspace) {
    return (
      <div ref={containerRef} className="file-mention-menu" role="listbox" aria-label="文件选择">
        <div className="file-mention-empty">
          <span>请先选择本对话的工作目录</span>
          {onPickWorkingDirectory ? (
            <button
              type="button"
              className="file-mention-pick"
              onClick={() => void onPickWorkingDirectory()}
            >
              选择工作目录 →
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div ref={containerRef} className="file-mention-menu" role="listbox" aria-label="文件选择">
        <div className="file-mention-empty">读取目录中…</div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div ref={containerRef} className="file-mention-menu" role="listbox" aria-label="文件选择">
        <div className="file-mention-empty">
          {query ? `没有匹配 "${query}" 的文件` : "工作目录里没有文件"}
        </div>
      </div>
    );
  }

  const visible = filtered.slice(0, VISIBLE_LIMIT);
  const hiddenCount = Math.max(0, filtered.length - VISIBLE_LIMIT);

  return (
    <div ref={containerRef} className="file-mention-menu" role="listbox" aria-label="文件选择">
      {visible.map((path, idx) => (
        <button
          key={path}
          type="button"
          role="option"
          aria-selected={idx === highlighted}
          className={"file-mention-item" + (idx === highlighted ? " active" : "")}
          onMouseEnter={() => setHighlighted(idx)}
          onClick={() => onPick(path)}
        >
          {renderHighlightedPath(path, query)}
        </button>
      ))}
      {hiddenCount > 0 ? (
        <div className="file-mention-footer">{hiddenCount} 个匹配未显示，输入更具体的关键字</div>
      ) : null}
    </div>
  );
}

function filterPaths(paths: ReadonlyArray<string>, query: string): string[] {
  if (!query) return paths.slice(0, 200);
  const needle = query.toLowerCase();
  const matches: string[] = [];
  for (const p of paths) {
    if (p.toLowerCase().includes(needle)) matches.push(p);
  }
  return matches;
}

function renderHighlightedPath(path: string, query: string) {
  if (!query) return path;
  const lower = path.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return path;
  return (
    <>
      {path.slice(0, idx)}
      <mark>{path.slice(idx, idx + query.length)}</mark>
      {path.slice(idx + query.length)}
    </>
  );
}
