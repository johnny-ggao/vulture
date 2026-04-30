import type { ChangeEvent } from "react";

export interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

/**
 * Single-line search box with `role="searchbox"` (set by the native input
 * `type="search"`) and an inline clear button when there is content.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "搜索…",
  ariaLabel = "搜索",
}: SearchInputProps) {
  return (
    <div className="search-input">
      <SearchIcon />
      <input
        type="search"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
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
}

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
