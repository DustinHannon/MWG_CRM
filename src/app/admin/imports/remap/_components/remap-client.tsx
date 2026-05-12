"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { remapImportedByNameAction } from "../actions";

/**
 * claim-and-remap client. Per row: shows the
 * imported_by_name string, the count of affected activities, the
 * most-recent activity timestamp, plus a user picker + Apply button.
 */
export interface PendingRow {
  name: string | null;
  count: number;
  mostRecent: Date | string;
}

export interface UserOption {
  id: string;
  displayName: string;
  email: string;
}

export function RemapClient({
  pending,
  users,
}: {
  pending: PendingRow[];
  users: UserOption[];
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, startTransition] = useTransition();
  // `new Date().toLocaleString()` returns
  // different strings on the server (UTC, env locale) vs the client
  // (user's locale + timezone), which triggers a React #418 hydration
  // mismatch. useSyncExternalStore returns the server snapshot during
  // SSR/hydration and the client snapshot from the first client render
  // forward — same hydration-safe swap as useEffect+useState, but
  // without setting state in an effect (react-hooks/set-state-in-effect).
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  function setPick(name: string, userId: string) {
    setPicks((prev) => ({ ...prev, [name]: userId }));
  }

  function applyRow(name: string) {
    const userId = picks[name];
    if (!userId) {
      toast.error("Pick a user first.");
      return;
    }
    if (
      !confirm(
        `Map every activity with By="${name}" to the selected user? This sets user_id and clears imported_by_name on every matching row.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const res = await remapImportedByNameAction({
        importedByName: name,
        newUserId: userId,
      });
      if (res.ok) {
        toast.success(`Remapped ${res.data.updated} activit(ies)`);
        // Optimistic: drop the row from local state since the server
        // page revalidates anyway.
        setPicks((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  if (pending.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        No pending imported-by names. Every imported activity has its
        <code className="mx-1">user_id</code>resolved.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-border/60 text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2">Imported-by name</th>
            <th className="px-4 py-2">Count</th>
            <th className="px-4 py-2">Most recent</th>
            <th className="px-4 py-2">Map to user</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {pending.map((row) => {
            const name = row.name ?? "(empty)";
            return (
              <tr key={name} className="align-top">
                <td className="px-4 py-2 font-mono text-xs">{name}</td>
                <td className="px-4 py-2 tabular-nums">{row.count}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {mounted
                    ? new Date(row.mostRecent).toLocaleString()
                    : new Date(row.mostRecent).toISOString()}
                </td>
                <td className="px-4 py-2">
                  <select
                    value={picks[name] ?? ""}
                    onChange={(e) => setPick(name, e.target.value)}
                    disabled={busy}
                    className="h-8 rounded-md border border-border bg-input/60 px-2 text-xs"
                  >
                    <option value="">— select —</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName} ({u.email})
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => applyRow(name)}
                    disabled={busy || !picks[name]}
                    className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? "Mapping…" : "Apply"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function subscribeNoop() {
  return () => {};
}
