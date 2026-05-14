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
import type {
  MarketingCampaignRow,
  MarketingCampaignStatus,
} from "@/lib/marketing/campaigns";

interface CampaignsListClientProps {
  timePrefs: TimePrefs;
  canCreate: boolean;
}

interface CampaignsFilters {
  q: string;
  status: MarketingCampaignStatus | "all";
}

const EMPTY_FILTERS: CampaignsFilters = {
  q: "",
  status: "all",
};

const STATUS_OPTIONS: ReadonlyArray<{
  value: CampaignsFilters["status"];
  label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
  { value: "sending", label: "Sending" },
  { value: "sent", label: "Sent" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_LABELS: Record<MarketingCampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function CampaignsListClient({
  timePrefs,
  canCreate,
}: CampaignsListClientProps) {
  const [filters, setFilters] = useState<CampaignsFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<CampaignsFilters>(EMPTY_FILTERS);

  const memoizedFilters = useMemo<CampaignsFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: CampaignsFilters,
    ): Promise<StandardListPagePage<MarketingCampaignRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.status !== "all") params.set("status", f.status);
      const res = await fetch(
        `/api/marketing/campaigns/list?${params.toString()}`,
        {
          headers: { Accept: "application/json" },
        },
      );
      if (!res.ok) {
        throw new Error(`Could not load campaigns (${res.status})`);
      }
      const json = (await res.json()) as {
        data: Array<
          Omit<MarketingCampaignRow, "updatedAt" | "scheduledFor" | "sentAt"> & {
            updatedAt: string;
            scheduledFor: string | null;
            sentAt: string | null;
          }
        >;
        nextCursor: string | null;
        total: number;
      };
      return {
        data: json.data.map((r) => ({
          ...r,
          updatedAt: new Date(r.updatedAt),
          scheduledFor: r.scheduledFor ? new Date(r.scheduledFor) : null,
          sentAt: r.sentAt ? new Date(r.sentAt) : null,
        })),
        nextCursor: json.nextCursor,
        total: json.total,
      };
    },
    [],
  );

  const renderRow = useCallback(
    (campaign: MarketingCampaignRow) => (
      <CampaignsDesktopRow campaign={campaign} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const renderCard = useCallback(
    (campaign: MarketingCampaignRow) => (
      <CampaignsMobileCard campaign={campaign} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(
    filters.q || filters.status !== "all",
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
          h-11 (44px) per WCAG 2.5.5. */}
      <div
        className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:gap-3 md:overflow-visible md:px-0 md:pb-0 md:[mask-image:none]"
      >
        <input
          type="search"
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyDraft();
            }
          }}
          placeholder="Search campaigns"
          className="h-11 min-w-[200px] flex-1 rounded-full border border-border bg-input px-4 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3"
        />
        <ControlledCampaignSelect
          value={draft.status}
          onChange={(v) =>
            setDraft({ ...draft, status: v as CampaignsFilters["status"] })
          }
          options={STATUS_OPTIONS}
          isSet={draft.status !== "all"}
        />
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
            Clear
          </button>
        ) : null}
      </div>
    </form>
  );

  // Desktop column header. 7 cells matching desktop row layout.
  const CAMPAIGN_COLS = 7;
  const columnHeaderSlot = (
    <div
      className="flex items-stretch text-xs font-medium uppercase tracking-wide text-muted-foreground"
      style={{ minWidth: `${CAMPAIGN_COLS * 140 + 40}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Name
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 md:block"
        style={{ flexBasis: "140px" }}
      >
        Template
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        List
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Status
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-right lg:block"
        style={{ flexBasis: "140px" }}
      >
        Sent
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-right lg:block"
        style={{ flexBasis: "140px" }}
      >
        Opens
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Updated
      </div>
    </div>
  );

  const headerActions = canCreate ? (
    <Link
      href="/marketing/campaigns/new"
      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
    >
      + New campaign
    </Link>
  ) : null;

  return (
    <StandardListPage<MarketingCampaignRow, CampaignsFilters>
      queryKey={["marketing-campaigns"]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={140}
      emptyState={
        <StandardEmptyState
          title={
            filtersAreModified
              ? "No campaigns match these filters"
              : "No campaigns yet"
          }
          description={
            filtersAreModified
              ? "Clear the filters to see all campaigns."
              : "Create a list and template, then send a campaign."
          }
        />
      }
      header={{
        title: "Campaigns",
        description: "Schedule, send, and track template sends to a list.",
        actions: headerActions,
      }}
      filtersSlot={filtersSlot}
      columnHeaderSlot={columnHeaderSlot}
    />
  );
}

function ControlledCampaignSelect({
  value,
  onChange,
  options,
  isSet,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  isSet: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        isSet
          ? "h-11 min-w-0 shrink-0 appearance-none rounded-full border border-primary/30 bg-primary/15 px-4 pr-8 text-sm font-medium text-foreground transition focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3 md:pr-7"
          : "h-11 min-w-0 shrink-0 appearance-none rounded-full border border-border bg-muted/40 px-4 pr-8 text-sm font-medium text-muted-foreground transition focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3 md:pr-7"
      }
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function CampaignsDesktopRow({
  campaign,
  timePrefs,
}: {
  campaign: MarketingCampaignRow;
  timePrefs: TimePrefs;
}) {
  // 7 cells matching columnHeaderSlot. flex-basis 140px per cell + row
  // min-width keep cells from squeezing below 140px when the table is
  // wider than the viewport.
  const minRowWidth = 7 * 140 + 40;
  return (
    <div
      className="group flex items-stretch border-b border-border/60 bg-card text-sm transition hover:bg-muted/40"
      data-row-flash="new"
      style={{ minWidth: `${minRowWidth}px` }}
    >
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        <Link
          href={`/marketing/campaigns/${campaign.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {campaign.name}
        </Link>
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground md:block"
        style={{ flexBasis: "140px" }}
      >
        {campaign.templateName ?? "—"}
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground lg:block"
        style={{ flexBasis: "140px" }}
      >
        {campaign.listName ?? "—"}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        <StatusPill status={campaign.status} />
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-right text-muted-foreground tabular-nums lg:block"
        style={{ flexBasis: "140px" }}
      >
        {campaign.totalSent.toLocaleString()}
        {campaign.totalRecipients > 0 ? (
          <span className="text-xs"> / {campaign.totalRecipients.toLocaleString()}</span>
        ) : null}
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-right text-muted-foreground tabular-nums lg:block"
        style={{ flexBasis: "140px" }}
      >
        {campaign.totalOpened.toLocaleString()}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground"
        style={{ flexBasis: "140px" }}
      >
        <UserTimeClient value={campaign.updatedAt} prefs={timePrefs} />
      </div>
    </div>
  );
}

function CampaignsMobileCard({
  campaign,
  timePrefs,
}: {
  campaign: MarketingCampaignRow;
  timePrefs: TimePrefs;
}) {
  return (
    <Link
      href={`/marketing/campaigns/${campaign.id}`}
      className="block rounded-md border border-border bg-card p-3 transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-foreground">
          {campaign.name}
        </span>
        <StatusPill status={campaign.status} />
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {campaign.templateName ?? "No template"}
        {campaign.listName ? <span> · {campaign.listName}</span> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Sent {campaign.totalSent.toLocaleString()}
          {campaign.totalRecipients > 0
            ? ` / ${campaign.totalRecipients.toLocaleString()}`
            : ""}
          {" · "}
          {campaign.totalOpened.toLocaleString()} opens
        </span>
        <UserTimeClient value={campaign.updatedAt} prefs={timePrefs} />
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: MarketingCampaignStatus }) {
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      data-status={status}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
