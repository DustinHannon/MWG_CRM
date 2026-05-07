"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { GlassCard } from "@/components/ui/glass-card";
import { updatePreferencesAction, type PreferencesPatch } from "../actions";

interface PrefsRow {
  version?: number | null;
  notifyTasksDue: boolean;
  notifyTasksAssigned: boolean;
  notifyMentions: boolean;
  notifySavedSearch: boolean;
  emailDigestFrequency: string;
}

export function NotificationsSection({ prefs }: { prefs: PrefsRow | null }) {
  const [pending, startTransition] = useTransition();
  // Phase 6B — version travels with every save and is updated from
  // the server's reply so subsequent toggles use the latest value.
  const [version, setVersion] = useState<number | undefined>(
    prefs?.version ?? undefined,
  );

  function save(patch: PreferencesPatch) {
    startTransition(async () => {
      const res = await updatePreferencesAction({ ...patch, version });
      if (res.ok) {
        setVersion(res.version);
        toast.success("Saved");
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  return (
    <section id="notifications" className="scroll-mt-10">
      <GlassCard className="p-6">
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Bell-icon notifications for events you care about. Auto-saves on
          change.
        </p>

        <div className="mt-5 space-y-3">
          <Toggle
            label="Tasks due today"
            defaultChecked={prefs?.notifyTasksDue ?? true}
            disabled={pending}
            onChange={(v) => save({ notifyTasksDue: v })}
          />
          <Toggle
            label="Tasks assigned to me"
            defaultChecked={prefs?.notifyTasksAssigned ?? true}
            disabled={pending}
            onChange={(v) => save({ notifyTasksAssigned: v })}
          />
          <Toggle
            label="@-mentions in notes"
            defaultChecked={prefs?.notifyMentions ?? true}
            disabled={pending}
            onChange={(v) => save({ notifyMentions: v })}
          />
          <Toggle
            label="Saved-search digest"
            defaultChecked={prefs?.notifySavedSearch ?? true}
            disabled={pending}
            onChange={(v) => save({ notifySavedSearch: v })}
          />
        </div>

        <div className="mt-6 border-t border-glass-border pt-5">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Email digest
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Sent from your own Microsoft 365 mailbox to yourself when there
            are new matches on your saved-search subscriptions.
          </p>
          <select
            defaultValue={prefs?.emailDigestFrequency ?? "off"}
            disabled={pending}
            onChange={(e) =>
              save({
                emailDigestFrequency: e.target.value as "off" | "daily" | "weekly",
              })
            }
            className="mt-2 h-9 w-48 rounded-md border border-glass-border bg-input/60 px-3 text-sm"
          >
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>
      </GlassCard>
    </section>
  );
}

interface ToggleProps {
  label: string;
  defaultChecked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ label, defaultChecked, disabled, onChange }: ToggleProps) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        defaultChecked={defaultChecked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer rounded border-glass-border bg-input/60 text-primary focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}
