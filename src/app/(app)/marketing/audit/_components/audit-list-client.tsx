"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, BarChart3 } from "lucide-react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { type TimePrefs } from "@/lib/format-time";
import { useShowPicker } from "@/hooks/use-show-picker";
import type { MarketingAuditRow } from "@/lib/marketing/audit-cursor";

interface AuditListClientProps {
  timePrefs: TimePrefs;
  adminCanFilterUser: boolean;
}

interface AuditFilters {
  q: string;
  type: string;
  user: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AuditFilters = {
  q: "",
  type: "",
  user: "",
  from: "",
  to: "",
};

export function MarketingAuditListClient({
  timePrefs,
  adminCanFilterUser,
}: AuditListClientProps) {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const fromPicker = useShowPicker();
  const toPicker = useShowPicker();

  const memoizedFilters = useMemo<AuditFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: AuditFilters,
    ): Promise<StandardListPagePage<MarketingAuditRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.type) params.set("type", f.type);
      if (f.user) params.set("user", f.user);
      if (f.from) params.set("from", f.from);
      if (f.to) params.set("to", f.to);
      const res = await fetch(
        `/api/marketing/audit/list?${params.toString()}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        throw new Error(`Could not load audit events (${res.status})`);
      }
      const json = (await res.json()) as {
        data: Array<
          Omit<MarketingAuditRow, "createdAt"> & { createdAt: string }
        >;
        nextCursor: string | null;
        total: number;
      };
      return {
        data: json.data.map((r) => ({
          ...r,
          createdAt: new Date(r.createdAt),
        })),
        nextCursor: json.nextCursor,
        total: json.total,
      };
    },
    [],
  );

  const renderRow = useCallback(
    (row: MarketingAuditRow) => (
      <AuditDesktopRow row={row} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const renderCard = useCallback(
    (row: MarketingAuditRow) => (
      <AuditMobileCard row={row} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(
    filters.q || filters.type || filters.user || filters.from || filters.to,
  );

  const filtersSlot = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyDraft();
      }}
      className="space-y-3"
    >
      {/* Mobile chip row: edge-fade mask hints overflow when chips
          exceed viewport width. Desktop layout (wrap, no overflow)
          resets the mask via md:[mask-image:none]. Touch targets are
          h-11 (44px) per WCAG 2.5.5. Datetime inputs and labeled
          inputs (event prefix, user UUID) retain their labels via
          aria-label on mobile; visible labels render above on desktop. */}
      <div
        className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:items-end md:gap-3 md:overflow-visible md:px-0 md:pb-0 md:[mask-image:none]"
      >
        {adminCanFilterUser ? (
          <div className="flex h-11 flex-col justify-end md:h-auto md:gap-1">
            <label
              htmlFor="audit-user"
              className="hidden text-[11px] uppercase tracking-wide text-muted-foreground md:block"
            >
              User ID
            </label>
            <input
              id="audit-user"
              name="user"
              type="text"
              value={draft.user}
              onChange={(e) => setDraft({ ...draft, user: e.target.value })}
              placeholder="User UUID"
              aria-label="User ID"
              className="h-11 w-56 rounded-full border border-border bg-input px-4 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3"
            />
          </div>
        ) : null}
        <div className="flex h-11 flex-col justify-end md:h-auto md:gap-1">
          <label
            htmlFor="audit-type"
            className="hidden text-[11px] uppercase tracking-wide text-muted-foreground md:block"
          >
            Event prefix
          </label>
          <input
            id="audit-type"
            name="type"
            type="text"
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value })}
            placeholder="campaign or template.update"
            aria-label="Event prefix"
            className="h-11 w-56 rounded-full border border-border bg-input px-4 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3"
          />
        </div>
        <div className="flex h-11 flex-col justify-end md:h-auto md:gap-1">
          <label
            htmlFor="audit-from"
            className="hidden text-[11px] uppercase tracking-wide text-muted-foreground md:block"
          >
            From
          </label>
          <input
            id="audit-from"
            name="from"
            type="datetime-local"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            onClick={fromPicker}
            aria-label="From"
            className="h-11 rounded-full border border-border bg-input px-4 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3"
          />
        </div>
        <div className="flex h-11 flex-col justify-end md:h-auto md:gap-1">
          <label
            htmlFor="audit-to"
            className="hidden text-[11px] uppercase tracking-wide text-muted-foreground md:block"
          >
            To
          </label>
          <input
            id="audit-to"
            name="to"
            type="datetime-local"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            onClick={toPicker}
            aria-label="To"
            className="h-11 rounded-full border border-border bg-input px-4 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3"
          />
        </div>
        <button
          type="submit"
          className="hidden h-11 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 md:inline-flex md:items-center"
        >
          Apply
        </button>
        {filtersAreModified ? (
          <button
            type="button"
            onClick={clearFilters}
            className="h-11 shrink-0 rounded-full px-4 text-sm text-muted-foreground hover:text-foreground/90 md:rounded-md md:border md:border-border md:bg-muted/40"
          >
            Reset
          </button>
        ) : null}
      </div>
    </form>
  );

  // Desktop column header. 5 cells matching audit desktop row layout.
  // Page size 100 (canonical default 50) is preserved as a marketing-
  // audit carveout for high-volume admin reading.
  const AUDIT_COLS = 5;
  const columnHeaderSlot = (
    <div
      className="flex items-stretch text-xs font-medium uppercase tracking-wide text-muted-foreground"
      style={{ minWidth: `${AUDIT_COLS * 140 + 40}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Time
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Actor
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Action
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        Target
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        Detail
      </div>
    </div>
  );

  const backLink = (
    <Link
      href="/marketing"
      className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to marketing
    </Link>
  );

  const headerActions = (
    <Link
      href="/marketing/reports/email"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm font-medium text-foreground whitespace-nowrap transition hover:bg-muted"
    >
      <BarChart3 className="h-4 w-4" aria-hidden />
      Marketing email report
    </Link>
  );

  // consistency-exempt: list-page-pattern: marketing-audit renders a
  // backLink above StandardListPage as a deliberate sub-navigation
  // affordance (the page is a deep admin surface reached from
  // /marketing).
  return (
    <div className="flex flex-col gap-4">
      {backLink}
      <StandardListPage<MarketingAuditRow, AuditFilters>
        entityType="marketing_audit_log"
        queryKey={["marketing-audit"]}
        fetchPage={fetchPage}
        filters={memoizedFilters}
        renderRow={renderRow}
        renderCard={renderCard}
        rowEstimateSize={64}
        cardEstimateSize={140}
        emptyState={
          <StandardEmptyState
            title="No marketing audit events match these filters."
            description={
              filtersAreModified
                ? "Reset the filters to see all events."
                : undefined
            }
          />
        }
        header={{
          title: "Marketing audit log",
          description:
            "Forensic record of every marketing template, list, campaign, and suppression action.",
          actions: headerActions,
        }}
        filtersSlot={filtersSlot}
        columnHeaderSlot={columnHeaderSlot}
      />
    </div>
  );
}

function AuditDesktopRow({
  row,
  timePrefs,
}: {
  row: MarketingAuditRow;
  timePrefs: TimePrefs;
}) {
  // 5 cells matching columnHeaderSlot. flex-basis 140px per cell + row
  // min-width keep cells from squeezing below 140px when the table is
  // wider than the viewport.
  const minRowWidth = 5 * 140 + 40;
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm"
      data-row-flash="new"
      style={{ minWidth: `${minRowWidth}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground"
        style={{ flexBasis: "140px" }}
      >
        <UserTimeClient value={row.createdAt} prefs={timePrefs} />
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-foreground"
        style={{ flexBasis: "140px" }}
      >
        {row.actorDisplayName ?? row.actorEmailSnapshot ?? "system"}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
          {row.action}
        </code>
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground lg:block"
        style={{ flexBasis: "140px" }}
      >
        <TargetCell targetType={row.targetType} targetId={row.targetId} />
      </div>
      <div
        className="hidden min-w-0 flex-1 px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        <MetadataCell before={row.beforeJson} after={row.afterJson} />
      </div>
    </div>
  );
}

function AuditMobileCard({
  row,
  timePrefs,
}: {
  row: MarketingAuditRow;
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
          {row.actorDisplayName ?? row.actorEmailSnapshot ?? "system"}
        </span>
      </div>
      <code className="block w-fit rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
        {row.action}
      </code>
      <div className="text-xs text-muted-foreground">
        <TargetCell targetType={row.targetType} targetId={row.targetId} />
      </div>
      <MetadataCell before={row.beforeJson} after={row.afterJson} />
    </div>
  );
}

function TargetCell({
  targetType,
  targetId,
}: {
  targetType: string | null;
  targetId: string | null;
}) {
  if (!targetType || !targetId) return <>—</>;
  const href = targetTypeToHref(targetType, targetId);
  if (!href) {
    return (
      <span className="text-xs">
        {targetType} <code className="text-[10px]">{targetId}</code>
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="text-xs text-foreground hover:underline"
      title={`${targetType} ${targetId}`}
    >
      {targetType}
    </Link>
  );
}

function targetTypeToHref(targetType: string, targetId: string): string | null {
  switch (targetType) {
    case "marketing_campaign":
      return `/marketing/campaigns/${targetId}`;
    case "marketing_template":
      return `/marketing/templates/${targetId}`;
    case "marketing_list":
      return `/marketing/lists/${targetId}`;
    default:
      return null;
  }
}

function MetadataCell({ before, after }: { before: unknown; after: unknown }) {
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  if (!hasBefore && !hasAfter) {
    return <span className="text-xs text-muted-foreground/60">—</span>;
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground transition hover:text-foreground">
        Inspect
      </summary>
      <div className="mt-2 flex flex-col gap-1 text-[11px]">
        {hasBefore ? (
          <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-foreground/80">
            <span className="text-muted-foreground">before:</span>{" "}
            {JSON.stringify(before, null, 2)}
          </pre>
        ) : null}
        {hasAfter ? (
          <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-foreground/80">
            <span className="text-muted-foreground">after:</span>{" "}
            {JSON.stringify(after, null, 2)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}
