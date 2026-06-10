"use client";

import type { OffboardCandidate } from "../actions";

export interface OffboardDecision {
  deactivate: boolean;
  reassignTo: string | null;
}

interface OffboardListProps {
  offboard: OffboardCandidate[];
  reassignTargets: { id: string; label: string }[];
  decisions: Map<string, OffboardDecision>;
  onChange: (userId: string, decision: OffboardDecision) => void;
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
        These active users are not in the Entra directory. Checked users are
        deactivated, which revokes access on their next request. Optionally
        reassign their leads, accounts, contacts, opportunities, and tasks.
      </p>
      <div className="divide-y divide-border rounded-md border border-border">
        {offboard.map((o) => {
          const decision = decisions.get(o.userId) ?? {
            deactivate: false,
            reassignTo: null,
          };
          return (
            <div
              key={o.userId}
              className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <label className="flex min-w-0 items-start gap-3">
                <input
                  type="checkbox"
                  aria-label={`Deactivate ${o.displayName}`}
                  checked={decision.deactivate}
                  onChange={(e) =>
                    onChange(o.userId, {
                      deactivate: e.target.checked,
                      reassignTo: e.target.checked
                        ? decision.reassignTo
                        : null,
                    })
                  }
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">
                    {o.displayName}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {o.email} · {o.leadCount} leads
                  </span>
                </span>
              </label>
              <select
                aria-label={`Reassign records owned by ${o.displayName}`}
                value={decision.reassignTo ?? ""}
                disabled={!decision.deactivate}
                onChange={(e) =>
                  onChange(o.userId, {
                    deactivate: decision.deactivate,
                    reassignTo: e.target.value || null,
                  })
                }
                className="rounded-md border border-border bg-input px-2 py-1 text-sm text-foreground disabled:opacity-50"
              >
                <option value="">No reassignment</option>
                {reassignTargets
                  .filter((t) => t.id !== o.userId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
