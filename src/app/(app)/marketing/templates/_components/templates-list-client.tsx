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
import type { MarketingTemplateRow } from "@/lib/marketing/templates";

interface TemplatesListClientProps {
  timePrefs: TimePrefs;
  canCreate: boolean;
}

interface TemplateFilters {
  q: string;
  status: "all" | "draft" | "ready" | "archived";
  scope: "all" | "global" | "personal";
}

const EMPTY_FILTERS: TemplateFilters = {
  q: "",
  status: "all",
  scope: "all",
};

const STATUS_OPTIONS: ReadonlyArray<{
  value: TemplateFilters["status"];
  label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
  { value: "archived", label: "Archived" },
];

const SCOPE_OPTIONS: ReadonlyArray<{
  value: TemplateFilters["scope"];
  label: string;
}> = [
  { value: "all", label: "All visibility" },
  { value: "global", label: "Global" },
  { value: "personal", label: "Personal" },
];

export function TemplatesListClient({
  timePrefs,
  canCreate,
}: TemplatesListClientProps) {
  const [filters, setFilters] = useState<TemplateFilters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<TemplateFilters>(EMPTY_FILTERS);

  const memoizedFilters = useMemo<TemplateFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: TemplateFilters,
    ): Promise<StandardListPagePage<MarketingTemplateRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.status !== "all") params.set("status", f.status);
      if (f.scope !== "all") params.set("scope", f.scope);
      const res = await fetch(`/api/marketing/templates/list?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Could not load templates (${res.status})`);
      }
      const json = (await res.json()) as {
        data: Array<
          Omit<MarketingTemplateRow, "updatedAt" | "createdAt"> & {
            updatedAt: string;
            createdAt: string;
          }
        >;
        nextCursor: string | null;
        total: number;
      };
      return {
        data: json.data.map((r) => ({
          ...r,
          updatedAt: new Date(r.updatedAt),
          createdAt: new Date(r.createdAt),
        })),
        nextCursor: json.nextCursor,
        total: json.total,
      };
    },
    [],
  );

  const renderRow = useCallback(
    (template: MarketingTemplateRow) => (
      <TemplateDesktopRow template={template} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const renderCard = useCallback(
    (template: MarketingTemplateRow) => (
      <TemplateMobileCard template={template} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  };
  const filtersAreModified = Boolean(
    filters.q ||
      (filters.status !== "all") ||
      (filters.scope !== "all"),
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
          placeholder="Search name or subject"
          className="h-11 min-w-[200px] flex-1 rounded-full border border-border bg-input px-4 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:rounded-md md:px-3"
        />
        <ControlledTemplateSelect
          value={draft.status}
          onChange={(v) =>
            setDraft({ ...draft, status: v as TemplateFilters["status"] })
          }
          options={STATUS_OPTIONS}
          isSet={draft.status !== "all"}
        />
        <ControlledTemplateSelect
          value={draft.scope}
          onChange={(v) =>
            setDraft({ ...draft, scope: v as TemplateFilters["scope"] })
          }
          options={SCOPE_OPTIONS}
          isSet={draft.scope !== "all"}
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

  // Desktop column header. Renders inside the horizontal-scroll wrapper
  // so it stays aligned with row cells when the table is wider than the
  // viewport. Non-sticky (the `overflow-x: auto` parent creates a
  // scrolling-mechanism context that breaks viewport-scoped sticky).
  const TEMPLATE_COLS = 6;
  const columnHeaderSlot = (
    <div
      className="flex items-stretch text-xs font-medium uppercase tracking-wide text-muted-foreground"
      style={{ minWidth: `${TEMPLATE_COLS * 140 + 40}px` }}
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
        Subject
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        Status
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        Visibility
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        Created by
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
      href="/marketing/templates/new"
      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
    >
      + New template
    </Link>
  ) : null;

  return (
    <StandardListPage<MarketingTemplateRow, TemplateFilters>
      entityType="marketing_template"
      queryKey={["marketing-templates"]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={56}
      cardEstimateSize={120}
      emptyState={
        <StandardEmptyState
          title={
            filtersAreModified
              ? "No templates match these filters"
              : "No templates yet"
          }
          description={
            filtersAreModified
              ? "Clear the filters to see all templates."
              : "Create a template to send campaigns."
          }
        />
      }
      header={{
        title: "Templates",
        description:
          "Drag-and-drop email designs synced to SendGrid as Dynamic Templates.",
        actions: headerActions,
      }}
      filtersSlot={filtersSlot}
      columnHeaderSlot={columnHeaderSlot}
    />
  );
}

function ControlledTemplateSelect({
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

function TemplateDesktopRow({
  template,
  timePrefs,
}: {
  template: MarketingTemplateRow;
  timePrefs: TimePrefs;
}) {
  // 6 cells matching columnHeaderSlot. flex-basis 140px per cell + row
  // min-width keep cells from squeezing below 140px when the table is
  // wider than the viewport (horizontal-scroll wrapper provides scroll).
  const minRowWidth = 6 * 140 + 40;
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
          href={`/marketing/templates/${template.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {template.name}
        </Link>
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground md:block"
        style={{ flexBasis: "140px" }}
      >
        {template.subject}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3"
        style={{ flexBasis: "140px" }}
      >
        <StatusBadge status={template.status} />
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 lg:block"
        style={{ flexBasis: "140px" }}
      >
        <ScopeBadge scope={template.scope} />
      </div>
      <div
        className="hidden min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground lg:block"
        style={{ flexBasis: "140px" }}
      >
        {template.createdByName ?? "—"}
      </div>
      <div
        className="min-w-0 flex-1 truncate px-5 py-3 text-muted-foreground"
        style={{ flexBasis: "140px" }}
      >
        <UserTimeClient value={template.updatedAt} prefs={timePrefs} />
      </div>
    </div>
  );
}

function TemplateMobileCard({
  template,
  timePrefs,
}: {
  template: MarketingTemplateRow;
  timePrefs: TimePrefs;
}) {
  return (
    <Link
      href={`/marketing/templates/${template.id}`}
      className="block rounded-md border border-border bg-card p-3 transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-foreground">
          {template.name}
        </span>
        <StatusBadge status={template.status} />
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {template.subject}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <ScopeBadge scope={template.scope} />
        <UserTimeClient value={template.updatedAt} prefs={timePrefs} />
      </div>
    </Link>
  );
}

function StatusBadge({ status }: { status: "draft" | "ready" | "archived" }) {
  const label =
    status === "draft" ? "Draft" : status === "ready" ? "Ready" : "Archived";
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      data-status={status}
    >
      {label}
    </span>
  );
}

function ScopeBadge({ scope }: { scope: "global" | "personal" }) {
  const label = scope === "global" ? "Global" : "Personal";
  return (
    <span
      className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground"
      data-scope={scope}
    >
      {label}
    </span>
  );
}
