// consistency-exempt: list-page-pattern: admin-utility-table —
// fixed-width row cells (w-40 timestamp, w-32 actor, w-32 entity,
// w-40 status, w-40 batches, flex-1 records) preserved because columns
// have intrinsically non-uniform widths; no columnHeaderSlot. The
// server shell embeds the runs list alongside a separate "start run"
// chrome section above the list, so this client renders only the runs
// catalog. Admin operational page — no saved views, no MODIFIED badge,
// no bulk selection.
"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { type TimePrefs } from "@/lib/format-time";
import { D365_ENTITY_TYPES } from "@/lib/d365/types";
import { RunStatusPill } from "./run-status-pill";

export interface ImportRunListRow {
  id: string;
  entityType: string;
  status: string;
  createdAt: string;
  createdById: string | null;
  createdByName: string | null;
  totalBatches: number;
  doneBatches: number;
  committedRecords: number;
}

const RUN_STATUSES = [
  "created",
  "fetching",
  "mapping",
  "reviewing",
  "committing",
  "paused_for_review",
  "completed",
  "aborted",
] as const;

interface ImportRunsFilters {
  status: string;
  entity: string;
}

const EMPTY_FILTERS: ImportRunsFilters = { status: "", entity: "" };

interface D365RunsListClientProps {
  timePrefs: TimePrefs;
  initialFilters: ImportRunsFilters;
}

export function D365RunsListClient({
  timePrefs,
  initialFilters,
}: D365RunsListClientProps) {
  const [filters, setFilters] = useState<ImportRunsFilters>(initialFilters);
  const [draft, setDraft] = useState<ImportRunsFilters>(initialFilters);

  const memoizedFilters = useMemo<ImportRunsFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: ImportRunsFilters,
    ): Promise<StandardListPagePage<ImportRunListRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.status) params.set("status", f.status);
      if (f.entity) params.set("entity", f.entity);
      const res = await fetch(
        `/api/admin/d365-import/list?${params.toString()}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        throw new Error(`Could not load import runs (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<ImportRunListRow>;
    },
    [],
  );

  const renderRow = useCallback(
    (row: ImportRunListRow) => (
      <RunDesktopRow row={row} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const renderCard = useCallback(
    (row: ImportRunListRow) => (
      <RunMobileCard row={row} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(filters.status || filters.entity);

  const filtersSlot = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyDraft();
      }}
      className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3"
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Status
        <select
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Any</option>
          {RUN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Entity
        <select
          value={draft.entity}
          onChange={(e) => setDraft({ ...draft, entity: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Any</option>
          {D365_ENTITY_TYPES.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
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
            Clear
          </button>
        ) : null}
      </div>
    </form>
  );

  return (
    <StandardListPage<ImportRunListRow, ImportRunsFilters>
      entityType="d365_import_run"
      queryKey={["admin-d365-import-runs"]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={140}
      emptyState={
        <StandardEmptyState
          title="No import runs yet"
          description={
            filtersAreModified
              ? "Try a different filter."
              : "Pick an entity above to start a run."
          }
        />
      }
      header={{
        title: "Import runs",
        description:
          "All runs across every entity, newest first. Open a run to review and commit pending batches.",
      }}
      filtersSlot={filtersSlot}
    />
  );
}

function RunDesktopRow({
  row,
  timePrefs,
}: {
  row: ImportRunListRow;
  timePrefs: TimePrefs;
}) {
  return (
    <Link
      href={`/admin/d365-import/${row.id}`}
      className="flex items-center gap-4 border-b border-border bg-card px-4 py-3 text-sm transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <div className="w-40 shrink-0 text-xs text-muted-foreground">
        <UserTimeClient value={row.createdAt} prefs={timePrefs} />
      </div>
      <div className="w-32 shrink-0 truncate text-foreground/90">
        {row.createdByName ?? "—"}
      </div>
      <div className="w-32 shrink-0 truncate font-mono text-xs text-foreground/90">
        {row.entityType}
      </div>
      <div className="w-40 shrink-0">
        <RunStatusPill status={row.status} />
      </div>
      <div className="hidden w-40 shrink-0 text-xs tabular-nums text-foreground/80 lg:block">
        {row.doneBatches} / {row.totalBatches} batches
      </div>
      <div className="hidden flex-1 text-xs tabular-nums text-foreground/80 lg:block">
        {row.committedRecords.toLocaleString()} records
      </div>
    </Link>
  );
}

function RunMobileCard({
  row,
  timePrefs,
}: {
  row: ImportRunListRow;
  timePrefs: TimePrefs;
}) {
  return (
    <Link
      href={`/admin/d365-import/${row.id}`}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
      data-row-flash="new"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-foreground/90">
          {row.entityType}
        </span>
        <RunStatusPill status={row.status} />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <UserTimeClient value={row.createdAt} prefs={timePrefs} />
        <span>{row.createdByName ?? "—"}</span>
      </div>
      <div className="text-xs tabular-nums text-foreground/80">
        {row.doneBatches} / {row.totalBatches} batches •{" "}
        {row.committedRecords.toLocaleString()} records
      </div>
    </Link>
  );
}
