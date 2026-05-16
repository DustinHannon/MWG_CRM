// consistency-exempt: list-page-pattern: admin-utility-table —
// fixed-width row cells (flex-1 name, w-20 count, w-40 timestamp,
// w-60 picker, w-24 apply) preserved because columns have intrinsic-
// ally non-uniform widths; no columnHeaderSlot. Post-action
// window.location.reload() is the documented carveout (CLAUDE.md
// §1.8) until StandardListPage exposes its queryClient for explicit
// invalidation. Bounded worklist (no pagination — fetchPage returns
// nextCursor:null). Admin operational page — no saved views, no
// MODIFIED badge, no bulk selection.
"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { type TimePrefs } from "@/lib/format-time";
import { remapImportedByNameAction } from "../actions";

export interface PendingRow {
  name: string | null;
  count: number;
  mostRecent: string;
}

interface UserOption {
  id: string;
  displayName: string;
  email: string;
}

type EmptyFilters = Record<string, never>;
const EMPTY_FILTERS: EmptyFilters = {};

interface RemapListClientProps {
  timePrefs: TimePrefs;
}

interface RemapListResponse extends StandardListPagePage<PendingRow> {
  users: UserOption[];
}

export function RemapListClient({ timePrefs }: RemapListClientProps) {
  // Single picker map kept at the parent so picker state survives row
  // re-renders. Apply triggers a server action; on success we
  // invalidate the query by refetching (StandardListPage's TanStack
  // Query client handles re-render).
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [users, setUsers] = useState<UserOption[]>([]);

  const filters = useMemo<EmptyFilters>(() => EMPTY_FILTERS, []);

  const fetchPage = useCallback(
    async (
      _cursor: string | null,
      _f: EmptyFilters,
    ): Promise<StandardListPagePage<PendingRow>> => {
      const res = await fetch(`/api/admin/imports/remap/list`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load remap queue (${res.status})`);
      }
      const json = (await res.json()) as RemapListResponse;
      // Hydrate the user picker list on every refetch — list is small
      // (active users) and stays fresh as the admin uses the page.
      setUsers(json.users);
      return {
        data: json.data,
        nextCursor: null,
        total: json.total,
      };
    },
    [],
  );

  const setPick = (name: string, userId: string) => {
    setPicks((prev) => ({ ...prev, [name]: userId }));
  };

  const renderRow = useCallback(
    (row: PendingRow) => (
      <PendingDesktopRow
        row={row}
        users={users}
        pick={picks[row.name ?? "(empty)"] ?? ""}
        onPickChange={(uid) => setPick(row.name ?? "(empty)", uid)}
        timePrefs={timePrefs}
      />
    ),
    [picks, users, timePrefs],
  );

  const renderCard = useCallback(
    (row: PendingRow) => (
      <PendingMobileCard
        row={row}
        users={users}
        pick={picks[row.name ?? "(empty)"] ?? ""}
        onPickChange={(uid) => setPick(row.name ?? "(empty)", uid)}
        timePrefs={timePrefs}
      />
    ),
    [picks, users, timePrefs],
  );

  return (
    <StandardListPage<PendingRow, EmptyFilters>
      entityType="import_remap"
      queryKey={["admin-imports-remap"]}
      fetchPage={fetchPage}
      filters={filters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={64}
      cardEstimateSize={180}
      emptyState={
        <StandardEmptyState
          title="No pending imported-by names"
          description="Every imported activity has its user_id resolved."
        />
      }
      header={{
        title: "Imported-by remap",
        description:
          'Imported activities whose "By:" name didn\'t resolve to a CRM user are listed below, grouped by the snapshot string. Pick the matching user; every activity for that name gets user_id set and imported_by_name cleared.',
      }}
    />
  );
}

function PendingDesktopRow({
  row,
  users,
  pick,
  onPickChange,
  timePrefs,
}: {
  row: PendingRow;
  users: UserOption[];
  pick: string;
  onPickChange: (uid: string) => void;
  timePrefs: TimePrefs;
}) {
  const name = row.name ?? "(empty)";
  return (
    <div
      className="flex items-center gap-4 border-b border-border bg-card px-4 py-3 text-sm"
      data-row-flash="new"
    >
      <div className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
        {name}
      </div>
      <div className="w-20 shrink-0 text-right tabular-nums text-foreground/80">
        {row.count}
      </div>
      <div className="hidden w-40 shrink-0 text-xs text-muted-foreground md:block">
        <UserTimeClient value={row.mostRecent} prefs={timePrefs} />
      </div>
      <div className="w-60 shrink-0">
        <select
          value={pick}
          onChange={(e) => onPickChange(e.target.value)}
          className="h-8 w-full rounded-md border border-border bg-input px-2 text-xs"
        >
          <option value="">— select —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName} ({u.email})
            </option>
          ))}
        </select>
      </div>
      <div className="w-24 shrink-0 text-right">
        <ApplyButton name={name} pickId={pick} />
      </div>
    </div>
  );
}

function PendingMobileCard({
  row,
  users,
  pick,
  onPickChange,
  timePrefs,
}: {
  row: PendingRow;
  users: UserOption[];
  pick: string;
  onPickChange: (uid: string) => void;
  timePrefs: TimePrefs;
}) {
  const name = row.name ?? "(empty)";
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-row-flash="new"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-foreground">
          {name}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-foreground/80">
          {row.count}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        Most recent: <UserTimeClient value={row.mostRecent} prefs={timePrefs} />
      </div>
      <select
        value={pick}
        onChange={(e) => onPickChange(e.target.value)}
        className="h-11 w-full rounded-md border border-border bg-input px-2 text-sm md:h-8 md:text-xs"
      >
        <option value="">— select —</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.displayName} ({u.email})
          </option>
        ))}
      </select>
      <div className="flex justify-end">
        <ApplyButton name={name} pickId={pick} />
      </div>
    </div>
  );
}

function ApplyButton({
  name,
  pickId,
}: {
  name: string;
  pickId: string;
}) {
  const [busy, startTransition] = useTransition();

  function apply() {
    if (!pickId) {
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
        importedByName: name === "(empty)" ? "" : name,
        newUserId: pickId,
      });
      if (res.ok) {
        toast.success(`Remapped ${res.data.updated} activit(ies)`);
        // The TanStack Query infinite scroll list does NOT auto-refetch
        // after a server action. The page's RowRealtime/PageRealtime
        // realtime layer doesn't trip on a single server action either.
        // A full reload is the simplest correctness guarantee — list is
        // tiny so the cost is negligible.
        window.location.reload();
      } else {
        toast.error(res.error, { duration: Infinity, dismissible: true });
      }
    });
  }

  return (
    <button
      type="button"
      onClick={apply}
      disabled={busy || !pickId}
      className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? "Mapping…" : "Apply"}
    </button>
  );
}
