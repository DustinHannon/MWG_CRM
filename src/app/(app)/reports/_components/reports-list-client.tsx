"use client";

import Link from "next/link";
import {
  BarChart3,
  CircleGauge,
  Filter,
  GitBranch,
  PieChart,
  Plus,
  Table as TableIcon,
  TrendingUp,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { type TimePrefs } from "@/lib/format-time";

export interface ReportRow {
  id: string;
  name: string;
  description: string | null;
  entityType: string;
  visualization: string;
  isShared: boolean;
  isBuiltin: boolean;
  ownerId: string;
  ownerName: string | null;
  updatedAt: string;
}

interface ReportsFilters {
  q: string;
  scope: "all" | "mine" | "shared";
}

const EMPTY_FILTERS: ReportsFilters = { q: "", scope: "all" };

const VIS_ICON: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  bar: BarChart3,
  line: TrendingUp,
  pie: PieChart,
  table: TableIcon,
  funnel: Filter,
  kpi: CircleGauge,
};

export function ReportsListClient() {
  const [filters, setFilters] = useState<ReportsFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<ReportsFilters>(EMPTY_FILTERS);

  const memoizedFilters = useMemo<ReportsFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: ReportsFilters,
    ): Promise<StandardListPagePage<ReportRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.scope !== "all") params.set("scope", f.scope);
      const res = await fetch(`/api/reports/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load reports (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<ReportRow>;
    },
    [],
  );

  const renderRow = useCallback(
    (row: ReportRow) => <ReportCardRow row={row} />,
    [],
  );

  const renderCard = useCallback(
    (row: ReportRow) => <ReportCardRow row={row} />,
    [],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(filters.q || filters.scope !== "all");

  const filtersSlot = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyDraft();
      }}
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3"
    >
      <input
        type="search"
        value={draft.q}
        onChange={(e) => setDraft({ ...draft, q: e.target.value })}
        placeholder="Search by name or description"
        className="min-w-[220px] flex-1 rounded-md border border-border bg-input px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      <select
        value={draft.scope}
        onChange={(e) => {
          const next: ReportsFilters = {
            ...draft,
            scope: e.target.value as ReportsFilters["scope"],
          };
          setDraft(next);
          setFilters(next);
        }}
        className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        <option value="all">All reports</option>
        <option value="mine">Mine only</option>
        <option value="shared">Shared only</option>
      </select>
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
    </form>
  );

  const headerActions = (
    <Link
      href="/reports/builder"
      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
    >
      <Plus className="h-4 w-4" /> New report
    </Link>
  );

  return (
    <StandardListPage<ReportRow, ReportsFilters>
      queryKey={["reports-user-and-shared"]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={180}
      cardEstimateSize={180}
      emptyState={
        <StandardEmptyState
          title="No saved reports match"
          description={
            filtersAreModified
              ? "Try a different filter."
              : "Create one from New report."
          }
        />
      }
      header={{
        title: "Your reports & shared",
        description:
          "Reports you own plus reports your teammates have shared. Built-in reports are listed above this section.",
      }}
      filtersSlot={filtersSlot}
    />
  );

  // headerActions intentionally not wired into header — the actions
  // slot collides with the page-level "+ New report" link; rendered
  // from the server shell instead.
  void headerActions;
}

function ReportCardRow({ row }: { row: ReportRow }) {
  return (
    <ReportCard row={row} timePrefs={null} />
  );
}

function ReportCard({
  row,
  timePrefs,
}: {
  row: ReportRow;
  timePrefs: TimePrefs | null;
}) {
  const Icon = VIS_ICON[row.visualization] ?? TableIcon;
  return (
    <Link
      href={`/reports/${row.id}`}
      className="block p-2 focus:outline-none"
      data-row-flash="new"
    >
      <GlassCard
        interactive
        weight="2"
        className="flex h-[160px] flex-col gap-3 p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-foreground/70">
            <Icon className="h-4 w-4" />
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {row.entityType}
            </span>
          </div>
          {row.isShared && !row.isBuiltin ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              <GitBranch className="h-3 w-3" /> Shared
            </span>
          ) : null}
        </div>
        <h3 className="text-base font-semibold leading-snug text-foreground">
          {row.name}
        </h3>
        {row.description ? (
          <p className="text-sm text-muted-foreground line-clamp-2">
            {row.description}
          </p>
        ) : (
          <p className="text-sm italic text-muted-foreground/60">
            No description.
          </p>
        )}
        <div className="mt-auto flex items-center justify-between text-[11px] text-muted-foreground/80">
          <span>
            Updated{" "}
            {timePrefs ? (
              <UserTimeClient
                value={row.updatedAt}
                prefs={timePrefs}
                mode="date"
              />
            ) : (
              new Date(row.updatedAt).toLocaleDateString()
            )}
          </span>
          {row.ownerName ? (
            <span className="truncate">By {row.ownerName}</span>
          ) : null}
        </div>
      </GlassCard>
    </Link>
  );
}
