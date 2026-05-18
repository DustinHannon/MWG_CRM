"use client";

import type { ReactNode } from "react";
import { useShowPicker } from "@/hooks/use-show-picker";

/**
 * Canonical server-action form primitives. Every create form
 * (lead/account/contact/opportunity) and the lead activity composer
 * carried byte-identical local `Section` / `Row` / `Input` / `Select`
 * helpers plus a copy-pasted error banner; that duplication is the
 * reason a validation/data-loss fix had to be applied N times. These
 * are the single source of truth — same markup as before (zero visual
 * change) plus inline per-field error display wired to
 * `ActionFailure.fieldErrors`.
 *
 * Contract: uncontrolled inputs (`defaultValue`) inside a
 * `<form action={formAction}>` driven by `useActionState`. Pass each
 * field its message via `error={fieldErrors?.[name]}`; the input gets
 * `aria-invalid` + `aria-describedby` and renders the message beneath
 * it. The form's typed values are preserved across a failed submit
 * because the form does not remount — never blank a form on error.
 */

const LABEL_CLASS =
  "block text-xs uppercase tracking-wide text-muted-foreground";
const CONTROL_CLASS =
  "mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 aria-[invalid=true]:border-[var(--status-lost-fg)]/60";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      className="mt-1 text-xs text-[var(--status-lost-fg)]"
    >
      {message}
    </p>
  );
}

export interface StandardFormFieldProps {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  step?: string;
  /** Mobile keyboard hint — use "decimal" for money so text round-trips. */
  inputMode?: "text" | "decimal" | "numeric" | "tel" | "email" | "url";
  maxLength?: number;
  /** Per-field validation message (from `ActionFailure.fieldErrors`). */
  error?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

/** Single labeled text/number/date/email input with inline error. */
export function StandardFormField({
  name,
  label,
  type = "text",
  defaultValue,
  placeholder,
  required,
  step,
  inputMode,
  maxLength,
  error,
  onChange,
}: StandardFormFieldProps) {
  const datePicker = useShowPicker();
  const isDateLike = type === "date" || type === "datetime-local";
  const errorId = `${name}-error`;
  return (
    <label className={LABEL_CLASS}>
      {label}
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        step={step}
        inputMode={inputMode}
        maxLength={maxLength}
        onChange={onChange}
        onClick={isDateLike ? datePicker : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={CONTROL_CLASS}
      />
      <FieldError id={errorId} message={error} />
    </label>
  );
}

export interface StandardFormTextareaProps {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  maxLength?: number;
  error?: string;
}

/** Labeled textarea with inline error. */
export function StandardFormTextarea({
  name,
  label,
  defaultValue,
  placeholder,
  rows = 5,
  required,
  maxLength,
  error,
}: StandardFormTextareaProps) {
  const errorId = `${name}-error`;
  return (
    <label className={LABEL_CLASS}>
      {label}
      <textarea
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        rows={rows}
        required={required}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={CONTROL_CLASS}
      />
      <FieldError id={errorId} message={error} />
    </label>
  );
}

export interface StandardFormSelectProps {
  name: string;
  label: string;
  options: readonly string[];
  defaultValue?: string;
  required?: boolean;
  error?: string;
  /** Leading blank option label (e.g. "—" / "— No account —"). */
  placeholderOption?: string;
}

/**
 * Labeled select. Option text is the value with underscores spaced
 * (`closed_won` → `closed won`) — matches the prior create-form
 * behavior; a no-op for values without underscores.
 */
export function StandardFormSelect({
  name,
  label,
  options,
  defaultValue,
  required,
  error,
  placeholderOption,
}: StandardFormSelectProps) {
  const errorId = `${name}-error`;
  return (
    <label className={LABEL_CLASS}>
      {label}
      <select
        name={name}
        defaultValue={defaultValue ?? (placeholderOption != null ? "" : undefined)}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={CONTROL_CLASS}
      >
        {placeholderOption != null ? (
          <option value="">{placeholderOption}</option>
        ) : null}
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <FieldError id={errorId} message={error} />
    </label>
  );
}

/** Card section wrapper (one logical group of fields). */
export function StandardFormSection({
  title,
  children,
  wide,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl ${
        wide ? "lg:col-span-2" : ""
      }`}
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** Two-up responsive field row. */
export function StandardFormRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

/**
 * Form-level error banner. Render with the action result's message for
 * failures that have no field mapping (forbidden / conflict / internal)
 * or as an always-on summary alongside inline field errors. Renders
 * nothing when `message` is falsy.
 */
export function StandardFormErrorBanner({
  message,
  className,
}: {
  message?: string;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={`rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-sm text-[var(--status-lost-fg)]${
        className ? ` ${className}` : ""
      }`}
    >
      {message}
    </div>
  );
}
