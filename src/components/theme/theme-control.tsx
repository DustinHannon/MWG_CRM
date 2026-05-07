"use client";

import { useState, useTransition } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { updatePreferencesAction } from "@/app/(app)/settings/actions";

type ThemeChoice = "system" | "light" | "dark";

interface ThemeControlProps {
  initial: ThemeChoice;
}

/**
 * Phase 5A — coordinates the theme toggle on /settings between the DB
 * and next-themes. Applying the visual change immediately gives a snappy
 * UX; persisting through a transition guards against the user spamming
 * the toggle. On save failure we revert both the visual state AND the
 * radio so the UI stays consistent with the DB.
 */
export function ThemeControl({ initial }: ThemeControlProps) {
  const { setTheme } = useTheme();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<ThemeChoice>(initial);

  function apply(next: ThemeChoice) {
    if (next === value) return;
    const prev = value;
    setValue(next);
    setTheme(next);
    startTransition(async () => {
      const res = await updatePreferencesAction({ theme: next });
      if (!res.ok) {
        setValue(prev);
        setTheme(prev);
        toast.error(res.error);
      } else {
        toast.success("Saved");
      }
    });
  }

  const options: { value: ThemeChoice; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label
          key={o.value}
          className={
            "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition " +
            (value === o.value
              ? "border-primary/40 bg-primary/15 text-foreground"
              : "border-glass-border bg-input/40 text-muted-foreground hover:border-glass-border hover:bg-accent/30")
          }
        >
          <input
            type="radio"
            name="theme"
            value={o.value}
            checked={value === o.value}
            disabled={pending}
            onChange={() => apply(o.value)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
