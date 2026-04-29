import type { ReactNode } from "react";

export interface FieldProps {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}

/**
 * Standard form field wrapper: visible label, optional required marker,
 * optional helper hint, and inline error with `role="alert"` for screen
 * readers.
 *
 * The visible `<span class="field-label">` is wrapped in a `<label>` for
 * implicit input association, while the hint and error live OUTSIDE that
 * `<label>` so they don't pollute the accessible name a screen reader
 * announces. The wrapping `<div class="field">` preserves the visual layout.
 */
export function Field({ label, required, hint, error, children }: FieldProps) {
  return (
    <div className="field">
      <label className="field-control">
        <span className="field-label">
          {label}
          {required ? (
            <span className="field-required" aria-hidden="true">*</span>
          ) : null}
        </span>
        {children}
      </label>
      {error ? (
        <span role="alert" className="field-error">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}
