"use client";

import { useRef } from "react";

/**
 * mobile-friendly filter select. Renders the same native
 * <select> the desktop form uses (so iOS / Android show their native
 * picker), but auto-submits its enclosing <form> on change so the
 * user doesn't have to also tap an Apply button. The visual chrome
 * is a chip-style pill that shows the current value or "All <Field>".
 */
export function MobileFilterSelect({
  name,
  defaultValue,
  options,
  placeholder,
}: {
  name: string;
  defaultValue?: string;
  options: readonly string[];
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
        <option key={o} value={o}>
          {o.replaceAll("_", " ")}
        </option>
      ))}
    </select>
  );
}
