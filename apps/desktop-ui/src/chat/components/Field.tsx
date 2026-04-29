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
 * optional helper hint, and inline error with `aria-live` for screen readers.
 *
 * Replaces the in-place `<label style={...}>` blocks scattered across
 * Settings sections and AgentsPage. The container is a labeled `<label>`
 * so clicking the visible label focuses the inner input automatically.
 */
export function Field({ label, required, hint, error, children }: FieldProps) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required ? <span className="field-required" aria-hidden="true">*</span> : null}
      </span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? (
        <span role="alert" className="field-error">
          {error}
        </span>
      ) : null}
    </label>
  );
}
