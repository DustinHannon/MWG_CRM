"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ThemeControl } from "@/components/theme/theme-control";
import { GlassCard } from "@/components/ui/glass-card";
import {
  updatePreferencesAction,
  type PreferencesPatch,
} from "../actions";

interface PrefsRow {
  version?: number | null;
  theme: string;
  defaultLandingPage: string;
  customLandingPath: string | null;
  defaultLeadsViewId: string | null;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  tableDensity: string;
  emailDigestFrequency: string;
}

interface PreferencesSectionProps {
  prefs: PrefsRow | null;
  savedViews: { id: string; name: string }[];
}

const TIMEZONES = [
  { value: "America/Chicago", label: "Central (US)" },
  { value: "America/New_York", label: "Eastern (US)" },
  { value: "America/Denver", label: "Mountain (US)" },
  { value: "America/Phoenix", label: "Arizona (no DST)" },
  { value: "America/Los_Angeles", label: "Pacific (US)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
  { value: "UTC", label: "UTC" },
];

const LANDING_OPTIONS = [
  { value: "/dashboard", label: "Dashboard (default)" },
  { value: "/leads?view=builtin:my-open", label: "My Open Leads" },
  { value: "/leads?view=builtin:all-mine", label: "All My Leads" },
  { value: "/leads?view=builtin:recent", label: "Recently Modified" },
  { value: "/custom", label: "Custom URL" },
];

export function PreferencesSection({ prefs, savedViews }: PreferencesSectionProps) {
  const [pending, startTransition] = useTransition();
  const [version, setVersion] = useState<number | undefined>(
    prefs?.version ?? undefined,
  );

  function save(patch: PreferencesPatch) {
    startTransition(async () => {
      const res = await updatePreferencesAction({ ...patch, version });
      if (res.ok) {
        setVersion(res.data.version);
        toast.success("Saved");
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  const theme = prefs?.theme ?? "system";
  const landing = prefs?.defaultLandingPage ?? "/dashboard";
  const customPath = prefs?.customLandingPath ?? "";
  const dvId = prefs?.defaultLeadsViewId ?? "";
  const tz = prefs?.timezone ?? "America/Chicago";
  const df = prefs?.dateFormat ?? "MM/DD/YYYY";
  const tf = prefs?.timeFormat ?? "12h";
  const td = prefs?.tableDensity ?? "comfortable";

  return (
    <section id="preferences" className="scroll-mt-10">
      <GlassCard className="p-6">
        <h2 className="text-lg font-semibold">Preferences</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Auto-saves on change.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
          <Field label="Theme">
            <ThemeControl
              initial={theme as "system" | "light" | "dark"}
              onSave={async (next) => {
                const res = await updatePreferencesAction({
                  theme: next,
                  version,
                });
                if (res.ok) {
                  setVersion(res.data.version);
                  return { ok: true };
                }
                return { ok: false, error: res.error };
              }}
            />
          </Field>

          <Field label="Default landing page">
            <select
              defaultValue={landing}
              disabled={pending}
              onChange={(e) =>
                save({ defaultLandingPage: e.target.value as PreferencesPatch["defaultLandingPage"] })
              }
              className="h-9 w-full rounded-md border border-glass-border bg-input/60 px-3 text-sm"
            >
              {LANDING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {landing === "/custom" ? (
              <input
                type="text"
                defaultValue={customPath ?? ""}
                placeholder="/leads?view=…"
                disabled={pending}
                onBlur={(e) =>
                  save({ customLandingPath: e.target.value || null })
                }
                className="mt-2 h-9 w-full rounded-md border border-glass-border bg-input/60 px-3 text-sm"
              />
            ) : null}
          </Field>

          <Field label="Default leads view">
            <select
              defaultValue={dvId ?? ""}
              disabled={pending}
              onChange={(e) =>
                save({
                  defaultLeadsViewId: e.target.value === "" ? null : e.target.value,
                })
              }
              className="h-9 w-full rounded-md border border-glass-border bg-input/60 px-3 text-sm"
            >
              <option value="">— None (use built-in default) —</option>
              {savedViews.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Time zone">
            <select
              defaultValue={tz}
              disabled={pending}
              onChange={(e) => save({ timezone: e.target.value })}
              className="h-9 w-full rounded-md border border-glass-border bg-input/60 px-3 text-sm"
            >
              {TIMEZONES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Date format">
            <RadioRow
              name="dateFormat"
              value={df}
              options={[
                { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
                { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
                { value: "YYYY-MM-DD", label: "YYYY-MM-DD" },
              ]}
              onChange={(v) =>
                save({ dateFormat: v as "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY-MM-DD" })
              }
              disabled={pending}
            />
          </Field>

          <Field label="Time format">
            <RadioRow
              name="timeFormat"
              value={tf}
              options={[
                { value: "12h", label: "12-hour" },
                { value: "24h", label: "24-hour" },
              ]}
              onChange={(v) => save({ timeFormat: v as "12h" | "24h" })}
              disabled={pending}
            />
          </Field>

          <Field label="Table density">
            <RadioRow
              name="tableDensity"
              value={td}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
              onChange={(v) =>
                save({ tableDensity: v as "comfortable" | "compact" })
              }
              disabled={pending}
            />
          </Field>
        </div>
      </GlassCard>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

interface RadioRowProps {
  name: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}

function RadioRow({ name, value, options, onChange, disabled }: RadioRowProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label
          key={o.value}
          className={
            "relative flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition " +
            (value === o.value
              ? "border-primary/40 bg-primary/15 text-foreground"
              : "border-glass-border bg-input/40 text-muted-foreground hover:border-glass-border hover:bg-accent/30")
          }
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
