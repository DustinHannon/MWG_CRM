"use client";

import type { OffboardCandidate } from "../actions";

interface OffboardListProps {
  offboard: OffboardCandidate[];
  reassignTargets: { id: string; label: string }[];
  decisions: Map<string, string | null>;
  onChange: (userId: string, reassignTo: string | null) => void;
}

export function OffboardList({
  offboard,
  reassignTargets,
  decisions,
  onChange,
}: OffboardListProps) {
  if (offboard.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        No active users are missing from the Entra directory.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        These active users are not in the Entra directory. Deactivating
        revokes access on their next request. Optionally reassign their
        leads, accounts, contacts, opportunities, and tasks.
      </p>
      <div className="divide-y divide-border rounded-md border border-border">
        {offboard.map((o) => (
          <div
            key={o.userId}
            className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground">
                {o.displayName}
              </div>
              <div className="truncate text-muted-foreground">
                {o.email} · {o.leadCount} leads
              </div>
            </div>
            <select
              aria-label={`Reassign records owned by ${o.displayName}`}
              value={decisions.get(o.userId) ?? ""}
              onChange={(e) =>
                onChange(o.userId, e.target.value || null)
              }
              className="rounded-md border border-border bg-input px-2 py-1 text-sm text-foreground"
            >
              <option value="">No one (leave as-is)</option>
              {reassignTargets
                .filter((t) => t.id !== o.userId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
