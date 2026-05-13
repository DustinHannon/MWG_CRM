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
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3"
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
        className="min-w-[200px] flex-1 rounded-md border border-border bg-input px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      <select
        value={draft.status}
        onChange={(e) =>
          setDraft({
            ...draft,
            status: e.target.value as TemplateFilters["status"],
          })
        }
        className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {STATUS_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <select
        value={draft.scope}
        onChange={(e) =>
          setDraft({
            ...draft,
            scope: e.target.value as TemplateFilters["scope"],
          })
        }
        className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {SCOPE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
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
    />
  );
}

function TemplateDesktopRow({
  template,
  timePrefs,
}: {
  template: MarketingTemplateRow;
  timePrefs: TimePrefs;
}) {
  return (
    <div
      className="flex items-center gap-4 border-b border-border bg-card px-4 py-3 text-sm transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <div className="min-w-0 flex-1">
        <Link
          href={`/marketing/templates/${template.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {template.name}
        </Link>
      </div>
      <div className="hidden min-w-0 flex-1 truncate text-muted-foreground md:block">
        {template.subject}
      </div>
      <div className="w-24 shrink-0">
        <StatusBadge status={template.status} />
      </div>
      <div className="hidden w-28 shrink-0 lg:block">
        <ScopeBadge scope={template.scope} />
      </div>
      <div className="hidden w-40 shrink-0 truncate text-muted-foreground lg:block">
        {template.createdByName ?? "—"}
      </div>
      <div className="w-32 shrink-0 text-muted-foreground">
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
