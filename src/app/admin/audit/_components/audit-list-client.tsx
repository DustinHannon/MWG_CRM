// consistency-exempt: list-page-pattern: admin-utility-table
// Admin /audit uses fixed-width row cells (w-40 timestamp, w-40 actor,
// w-56 action mnemonic, w-32 request id, w-24 diff) rather than the
// canonical 140px flex-basis pattern because the columns have
// intrinsically non-uniform widths (audit action codes are long, diff
// cell is narrow). No columnHeaderSlot to align against. Admin
// operational page — no saved views, no MODIFIED badge, no bulk
// selection.
"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { UserChip } from "@/components/user-display/user-chip";
import { type TimePrefs } from "@/lib/format-time";
import { useShowPicker } from "@/hooks/use-show-picker";

export interface AuditRow {
  id: string;
  actorId: string | null;
  actorDisplayName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  requestId: string | null;
  createdAt: string;
}

interface AuditFilters {
  q: string;
  action: string;
  targetType: string;
  requestId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AuditFilters = {
  q: "",
  action: "",
  targetType: "",
  requestId: "",
  from: "",
  to: "",
};

interface AuditListClientProps {
  timePrefs: TimePrefs;
  targetTypes: string[];
  initialFilters: AuditFilters;
}

export function AuditListClient({
  timePrefs,
  targetTypes,
  initialFilters,
}: AuditListClientProps) {
  const [filters, setFilters] = useState<AuditFilters>(initialFilters);
  const [draft, setDraft] = useState<AuditFilters>(initialFilters);
  const fromPicker = useShowPicker();
  const toPicker = useShowPicker();

  const memoizedFilters = useMemo<AuditFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: AuditFilters,
    ): Promise<StandardListPagePage<AuditRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.action) params.set("action", f.action);
      if (f.targetType) params.set("target_type", f.targetType);
      if (f.requestId) params.set("request_id", f.requestId);
      if (f.from) params.set("created_at_gte", f.from);
      if (f.to) params.set("created_at_lte", f.to);
      const res = await fetch(`/api/admin/audit/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load audit events (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<AuditRow>;
    },
    [],
  );

  const renderRow = useCallback(
    (row: AuditRow) => <AuditDesktopRow row={row} timePrefs={timePrefs} />,
    [timePrefs],
  );

  const renderCard = useCallback(
    (row: AuditRow) => <AuditMobileCard row={row} timePrefs={timePrefs} />,
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(
    filters.q ||
      filters.action ||
      filters.targetType ||
      filters.requestId ||
      filters.from ||
      filters.to,
  );

  // Build filter-preserving export URL. Keeps the existing
  // /admin/audit/export route as-is; just appends the active params.
  const exportParams = new URLSearchParams();
  if (filters.q) exportParams.set("q", filters.q);
  if (filters.action) exportParams.set("action", filters.action);
  if (filters.targetType) exportParams.set("target_type", filters.targetType);
  if (filters.requestId) exportParams.set("request_id", filters.requestId);
  if (filters.from) exportParams.set("created_at_gte", filters.from);
  if (filters.to) exportParams.set("created_at_lte", filters.to);
  const exportHref = `/admin/audit/export${
    exportParams.toString() ? `?${exportParams.toString()}` : ""
  }`;

  const filtersSlot = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyDraft();
      }}
      className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3"
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Search
        <input
          type="search"
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          placeholder="action / target / actor"
          className="h-11 min-w-[220px] rounded-md border border-border bg-input px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:h-9 md:py-1.5"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Action
        <input
          type="text"
          value={draft.action}
          onChange={(e) => setDraft({ ...draft, action: e.target.value })}
          placeholder="lead.update"
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Entity type
        <select
          value={draft.targetType}
          onChange={(e) => setDraft({ ...draft, targetType: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Any</option>
          {targetTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Request id
        <input
          type="text"
          value={draft.requestId}
          onChange={(e) => setDraft({ ...draft, requestId: e.target.value })}
          placeholder="uuid"
          className="w-40 rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        From
        <input
          type="date"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          onClick={fromPicker}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        To
        <input
          type="date"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          onClick={toPicker}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          Apply
        </button>
        {filtersAreModified ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
        <Link
          href={exportHref}
          className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted md:inline-flex"
          title="Download up to 50,000 matching rows as CSV"
        >
          Export CSV
        </Link>
      </div>
    </form>
  );

  return (
    <StandardListPage<AuditRow, AuditFilters>
      entityType="audit_log"
      queryKey={["admin-audit"]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={64}
      cardEstimateSize={160}
      emptyState={
        <StandardEmptyState
          title="No audit events match"
          description={
            filtersAreModified ? "Reset the filters to see all events." : undefined
          }
        />
      }
      header={{
        title: "Audit log",
        description: "Append-only forensic record of every meaningful mutation.",
      }}
      filtersSlot={filtersSlot}
    />
  );
}

function AuditDesktopRow({
  row,
  timePrefs,
}: {
  row: AuditRow;
  timePrefs: TimePrefs;
}) {
  return (
    <div
      className="flex items-start gap-4 border-b border-border bg-card px-4 py-3 text-sm"
      data-row-flash="new"
    >
      <div className="w-40 shrink-0 text-xs text-muted-foreground tabular-nums">
        <UserTimeClient value={row.createdAt} prefs={timePrefs} />
      </div>
      <div className="w-40 shrink-0">
        {row.actorId ? (
          <UserChip
            user={{
              id: row.actorId,
              displayName: row.actorDisplayName,
              photoUrl: null,
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground/80">system</span>
        )}
      </div>
      <div
        className="w-56 shrink-0 min-w-0 truncate font-mono text-xs text-foreground/90"
        title={row.action}
      >
        {row.action}
      </div>
      <div className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground lg:block">
        {row.targetType ? (
          <>
            <span className="text-foreground/90">{row.targetType}</span>
            {row.targetId ? (
              <div className="font-mono text-[10px] text-muted-foreground/80">
                {row.targetId}
              </div>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </div>
      <div className="hidden w-32 shrink-0 text-xs lg:block">
        {row.requestId ? (
          <Link
            href={`/admin/audit?request_id=${encodeURIComponent(row.requestId)}`}
            className="font-mono text-[10px] text-foreground/80 underline-offset-4 hover:text-foreground hover:underline"
            title={row.requestId}
          >
            {row.requestId.slice(0, 12)}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
      <div className="hidden w-24 shrink-0 text-xs xl:block">
        <DiffCell before={row.beforeJson} after={row.afterJson} />
      </div>
    </div>
  );
}

function AuditMobileCard({
  row,
  timePrefs,
}: {
  row: AuditRow;
  timePrefs: TimePrefs;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
      data-row-flash="new"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <UserTimeClient value={row.createdAt} prefs={timePrefs} />
        <span className="truncate text-foreground">
          {row.actorDisplayName ?? "system"}
        </span>
      </div>
      <code className="block w-fit rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
        {row.action}
      </code>
      {row.targetType ? (
        <div className="text-xs text-muted-foreground">
          <span className="text-foreground/90">{row.targetType}</span>
          {row.targetId ? (
            <span className="ml-1 font-mono text-[10px]">{row.targetId}</span>
          ) : null}
        </div>
      ) : null}
      <DiffCell before={row.beforeJson} after={row.afterJson} />
    </div>
  );
}

function DiffCell({ before, after }: { before: unknown; after: unknown }) {
  if (!before && !after) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <details>
      <summary className="cursor-pointer text-xs text-foreground/80 underline-offset-4 hover:underline">
        view
      </summary>
      <pre className="mt-2 max-w-md overflow-x-auto rounded bg-black/30 p-2 font-mono text-[10px] text-foreground/90">
        {JSON.stringify({ before, after }, null, 2)}
      </pre>
    </details>
  );
}
