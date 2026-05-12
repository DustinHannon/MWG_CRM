"use client";

import { useRef } from "react";

/**
 * mobile-friendly filter select for /contacts. Renders the same
 * native <select> the desktop form uses, but auto-submits its
 * enclosing <form> on change so the user doesn't have to also tap an
 * Apply button. Chip-style pill that shows the current value or
 * "All <Field>".
 */
export function MobileContactFilterSelect({
  name,
  defaultValue,
  options,
  placeholder,
}: {
  name: string;
  defaultValue?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
}) {
  const ref = useRef<HTMLSelectElement>(null);

  function autoSubmit() {
    const form = ref.current?.closest("form");
    if (form) form.requestSubmit();
  }

  const isSet = defaultValue && defaultValue.length > 0;
  return (
    <select
      ref={ref}
      name={name}
      defaultValue={defaultValue ?? ""}
      onChange={autoSubmit}
      className={
        "h-9 min-w-0 shrink-0 appearance-none rounded-full border px-3 pr-7 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-ring/40 " +
        (isSet
          ? "border-primary/30 bg-primary/15 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground")
      }
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='currentColor'><path d='M5.516 7.548c.436-.446 1.043-.481 1.527 0L10 10.5l2.957-2.952c.483-.481 1.091-.446 1.527 0 .437.445.418 1.196 0 1.625-.418.43-4.5 4.5-4.5 4.5a1.063 1.063 0 0 1-1.498 0s-4.083-4.07-4.5-4.5c-.418-.43-.436-1.18 0-1.625Z'/></svg>\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 0.5rem center",
        backgroundSize: "1rem",
      }}
    >
      <option value="">All {placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * boolean chip toggle (DNC / Don't email / Don't call). When checked,
 * the hidden field submits "1"; when unchecked it submits no value so
 * `?doNotContact=` is absent from the URL.
 */
export function MobileContactBooleanChip({
  name,
  defaultChecked,
  label,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  function autoSubmit() {
    const form = ref.current?.closest("form");
    if (form) form.requestSubmit();
  }

  return (
    <label
      className={
        "inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition focus-within:ring-2 focus-within:ring-ring/40 " +
        (defaultChecked
          ? "border-primary/30 bg-primary/15 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground")
      }
    >
      <input
        ref={ref}
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        value="1"
        onChange={autoSubmit}
        className="h-3.5 w-3.5 rounded border-border bg-muted/40 text-primary focus:ring-ring"
      />
      <span>{label}</span>
    </label>
  );
}
