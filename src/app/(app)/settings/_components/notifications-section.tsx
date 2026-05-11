"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { GlassCard } from "@/components/ui/glass-card";
import { updatePreferencesAction, type PreferencesPatch } from "../actions";
import {
  unsubscribeFromViewAction,
  updateSubscriptionFrequencyAction,
} from "../subscriptions-actions";

interface PrefsRow {
  version?: number | null;
  notifyTasksDue: boolean;
  notifyTasksAssigned: boolean;
  notifyMentions: boolean;
  notifySavedSearch: boolean;
  emailDigestFrequency: string;
}

interface SubscriptionRow {
  subscriptionId: string;
  savedViewId: string;
  frequency: string;
  lastRunAt: Date | null;
  createdAt: Date;
  viewName: string;
}

export function NotificationsSection({
  prefs,
  subscriptions,
}: {
  prefs: PrefsRow | null;
  subscriptions: SubscriptionRow[];
}) {
  const [pending, startTransition] = useTransition();
  // Phase 6B — version travels with every save and is updated from
  // the server's reply so subsequent toggles use the latest value.
  const [version, setVersion] = useState<number | undefined>(
    prefs?.version ?? undefined,
  );
  // Phase 25 §7.2 — local optimistic copy of the subscriptions list
  // so unsubscribe / frequency-update feel responsive. Server actions
  // revalidate /settings on success which refills from the DB.
  const [subs, setSubs] = useState<SubscriptionRow[]>(subscriptions);
  const masterEnabled = prefs?.notifySavedSearch ?? true;

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

  function changeSubFrequency(sub: SubscriptionRow, frequency: string) {
    if (frequency !== "daily" && frequency !== "weekly") return;
    startTransition(async () => {
      const res = await updateSubscriptionFrequencyAction({
        savedViewId: sub.savedViewId,
        frequency,
      });
      if (res.ok) {
        setSubs((prev) =>
          prev.map((s) =>
            s.subscriptionId === sub.subscriptionId
              ? { ...s, frequency }
              : s,
          ),
        );
        toast.success("Frequency updated");
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  function unsubscribe(sub: SubscriptionRow) {
    if (
      !confirm(
        `Unsubscribe from "${sub.viewName}"? You can resubscribe from the Leads view at any time.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await unsubscribeFromViewAction({
        savedViewId: sub.savedViewId,
      });
      if (res.ok) {
        setSubs((prev) =>
          prev.filter((s) => s.subscriptionId !== sub.subscriptionId),
        );
        toast.success(`Unsubscribed from "${sub.viewName}"`);
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
            label="Saved-search digest (master)"
            defaultChecked={masterEnabled}
            disabled={pending}
            onChange={(v) => save({ notifySavedSearch: v })}
          />
        </div>

        <div className="mt-6 border-t border-glass-border pt-5">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Email digest — default for new subscriptions
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Sent from your own Microsoft 365 mailbox to yourself when there
            are new matches. New subscriptions inherit this cadence. Each
            existing subscription can override below. Set to {`"`}Off{`"`}
            to suppress emails entirely (you{`'`}ll still get in-app
            notifications while the master toggle is on).
          </p>
          <select
            defaultValue={prefs?.emailDigestFrequency ?? "off"}
            disabled={pending}
            onChange={(e) =>
              save({
                emailDigestFrequency: e.target.value as
                  | "off"
                  | "daily"
                  | "weekly",
              })
            }
            className="mt-2 h-9 w-48 rounded-md border border-glass-border bg-input/60 px-3 text-sm"
          >
            <option value="off">Off</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>

        {/* Phase 25 §7.2 — per-subscription list. */}
        <div className="mt-6 border-t border-glass-border pt-5">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Active subscriptions
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                Subscribe to a saved view from the Leads view selector. Each
                subscription can have its own cadence; the master toggle
                above suppresses every subscription at once.
              </p>
            </div>
            <span className="text-xs text-muted-foreground/80">
              {subs.length} active
            </span>
          </div>

          {subs.length === 0 ? (
            <p className="mt-4 rounded-md border border-dashed border-glass-border bg-muted/20 p-4 text-xs text-muted-foreground">
              No active subscriptions. Open the Leads page, pick a saved
              view, and click Subscribe in the toolbar to start receiving
              its digest.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-glass-border/60 rounded-md border border-glass-border bg-muted/10">
              {subs.map((sub) => (
                <li
                  key={sub.subscriptionId}
                  className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {sub.viewName}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {sub.lastRunAt
                        ? `Last digest sent ${new Date(sub.lastRunAt).toLocaleString()}`
                        : "Never sent yet"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={sub.frequency}
                      disabled={pending}
                      onChange={(e) =>
                        changeSubFrequency(sub, e.target.value)
                      }
                      className="h-8 rounded-md border border-glass-border bg-input/60 px-2 text-xs"
                      aria-label={`Frequency for ${sub.viewName}`}
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => unsubscribe(sub)}
                      disabled={pending}
                      className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
                    >
                      Unsubscribe
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
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
