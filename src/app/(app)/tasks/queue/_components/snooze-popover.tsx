"use client";

import { useMemo, useState } from "react";
import { Clock } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { parseDueDateInUserTz, snoozePresets } from "@/lib/dates";

export interface SnoozePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  timezone: string;
  /** ISO string of current dueAt, used to pick the default custom date. */
  currentDueAt: string | null;
  /** Called with the UTC instant chosen. The caller persists via updateTaskAction. */
  onSelect: (targetUtc: Date) => Promise<void> | void;
}

function isoDateInTz(value: Date, timezone: string): string {
  // Render the calendar date that `value` falls on in `timezone` as
  // `YYYY-MM-DD` — used to prefill the custom-date input so the picker
  // shows the day the user expects, not the UTC day.
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(value);
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

export function SnoozePopover({
  open,
  onOpenChange,
  disabled,
  timezone,
  currentDueAt,
  onSelect,
}: SnoozePopoverProps) {
  // Recompute presets whenever the popover transitions to open so a
  // session held across midnight / DST still computes wall-clock-
  // accurate quick-snooze targets. We rebind `now` on the open edge
  // and re-derive presets from there; closing-then-reopening picks up
  // a fresh clock.
  const presets = useMemo(() => {
    void open;
    return snoozePresets(new Date(), timezone);
  }, [open, timezone]);
  // Sticky "now" reference for the custom-date pre-fill below — same
  // open-edge re-derive semantics.
  const now = useMemo(() => {
    void open;
    return new Date();
  }, [open]);

  // Default "Pick a date" to the calendar day AFTER the task's current
  // due date in user tz (or after "now" if no due date). Done as
  // calendar arithmetic on the YYYY-MM-DD string — not `+ 24h` in UTC
  // — so a spring-forward / fall-back day doesn't shift the default
  // by ±1.
  const defaultCustomDate = useMemo(() => {
    const baseYmd = currentDueAt
      ? isoDateInTz(new Date(currentDueAt), timezone)
      : isoDateInTz(now, timezone);
    const [y, m, d] = baseYmd.split("-").map(Number);
    if (!y || !m || !d) return baseYmd;
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  }, [currentDueAt, now, timezone]);

  const [customDate, setCustomDate] = useState<string>(defaultCustomDate);

  async function pick(target: Date) {
    onOpenChange(false);
    await onSelect(target);
  }

  async function pickCustom() {
    const target = parseDueDateInUserTz(customDate, timezone);
    if (!target) return;
    await pick(target);
  }

  const items: Array<{ label: string; target: Date }> = [
    { label: "Later today", target: presets.laterToday },
    { label: "Tomorrow morning", target: presets.tomorrowMorning },
    { label: "Next Monday morning", target: presets.nextMondayMorning },
    { label: "In two weeks", target: presets.twoWeeks },
  ];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Snooze task"
        >
          <Clock className="h-4 w-4" aria-hidden /> Snooze
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-64 p-2">
        <div className="flex flex-col">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              disabled={disabled}
              onClick={() => {
                void pick(it.target);
              }}
              className="rounded-md px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {it.label}
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <label className="px-3 py-1 text-xs text-muted-foreground">
            Pick a date
          </label>
          <div className="flex items-center gap-2 px-3 pb-2 pt-1">
            <input
              type="date"
              value={customDate}
              disabled={disabled}
              onChange={(e) => setCustomDate(e.target.value)}
              className="flex-1 rounded-md border border-border bg-input px-2 py-1 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => {
                void pickCustom();
              }}
              disabled={disabled || !customDate}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
