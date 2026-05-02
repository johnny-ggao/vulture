import { forwardRef, useEffect, useRef, type ChangeEvent } from "react";

export interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /**
   * Bind a global "/" key that focuses + selects the input. Press Esc
   * inside the input to blur. Skipped when the user is typing in
   * another field. Pages that own a single primary search box should
   * pass `true` so power users can jump to search the way Linear /
   * GitHub / Slack do.
   */
  shortcut?: boolean;
}

/**
 * Single-line search box with `role="searchbox"` (set by the native input
 * `type="search"`) and an inline clear button when there is content.
 *
 * When `shortcut` is true, the global "/" key focuses + selects the
 * input (matching Linear / GitHub / Slack), and Esc inside blurs it.
 * Implemented as a window-level keydown so deeply-nested mounts still
 * pick up the shortcut.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    { value, onChange, placeholder = "搜索…", ariaLabel = "搜索", shortcut = false },
    forwardedRef,
  ) {
    const innerRef = useRef<HTMLInputElement | null>(null);
    const setRef = (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    };

    useEffect(() => {
      if (!shortcut) return;
      function onKey(event: KeyboardEvent) {
        if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        const typing =
          tag === "input" || tag === "textarea" || target?.isContentEditable === true;
        if (typing) return;
        const node = innerRef.current;
        if (!node) return;
        event.preventDefault();
        node.focus();
        node.select();
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [shortcut]);

    return (
      <div className="search-input">
        <SearchIcon />
        <input
          ref={setRef}
          type="search"
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Escape inside the search blurs back to the page so a
            // subsequent "/" can re-trigger from the document.
            if (event.key === "Escape") {
              event.currentTarget.blur();
            }
          }}
        />
        {value ? (
          <button
            type="button"
            aria-label="清空搜索"
            className="search-clear"
            onClick={() => onChange("")}
          >
            <ClearIcon />
          </button>
        ) : null}
      </div>
    );
  },
);

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M14 14l-3.5-3.5" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4l8 8M4 12l8-8" />
    </svg>
  );
}
