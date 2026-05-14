// consistency-exempt: theming: raw red/amber/emerald/sky tints in
// methodChipClass + statusChipClass — preserves pre-existing
// CLAUDE.md §12 exception for HTTP status-code and HTTP method
// semantics (color-coded for at-a-glance operational reading).
//
// consistency-exempt: list-page-pattern: admin-utility-table —
// fixed-width row cells (w-32 timestamp, w-32 key, flex-1 method+path,
// w-36 status, w-20 duration, w-32 ip, w-24 detail) preserved because
// columns have intrinsically non-uniform widths; no columnHeaderSlot.
// pageSize=100 (high-volume admin reading). Admin operational page —
// no saved views, no MODIFIED badge, no bulk selection.
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
import { cn } from "@/lib/utils";

export interface ApiUsageRow {
  id: string;
  createdAt: string;
  apiKeyId: string | null;
  apiKeyNameSnapshot: string;
  apiKeyPrefixSnapshot: string;
  method: string;
  path: string;
  action: string | null;
  statusCode: number;
  responseTimeMs: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestQuery: unknown;
  requestBodySummary: unknown;
  responseSummary: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
const STATUS_BUCKETS = [
  { value: "2xx", label: "2xx" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
] as const;

export interface ApiUsageFilters {
  q: string;
  method: string;
  path: string;
  apiKeyId: string;
  statusBuckets: string[];
  from: string;
  to: string;
}

interface ApiUsageListClientProps {
  timePrefs: TimePrefs;
  apiKeyOptions: Array<{
    id: string;
    name: string;
    prefix: string;
    revoked: boolean;
  }>;
  initialFilters: ApiUsageFilters;
}

export function ApiUsageListClient({
  timePrefs,
  apiKeyOptions,
  initialFilters,
}: ApiUsageListClientProps) {
  const [filters, setFilters] = useState<ApiUsageFilters>(initialFilters);
  const [draft, setDraft] = useState<ApiUsageFilters>(initialFilters);

  const memoizedFilters = useMemo<ApiUsageFilters>(() => filters, [filters]);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: ApiUsageFilters,
    ): Promise<StandardListPagePage<ApiUsageRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (f.q) params.set("q", f.q);
      if (f.method) params.set("method", f.method);
      if (f.path) params.set("path", f.path);
      if (f.apiKeyId) params.set("api_key_id", f.apiKeyId);
      if (f.statusBuckets.length > 0) {
        params.set("status", f.statusBuckets.join(","));
      }
      if (f.from) params.set("created_at_gte", f.from);
      if (f.to) params.set("created_at_lte", f.to);
      const res = await fetch(
        `/api/admin/api-usage/list?${params.toString()}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        throw new Error(`Could not load API usage (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<ApiUsageRow>;
    },
    [],
  );

  const renderRow = useCallback(
    (row: ApiUsageRow) => (
      <ApiUsageDesktopRow row={row} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const renderCard = useCallback(
    (row: ApiUsageRow) => (
      <ApiUsageMobileCard row={row} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    const cleared: ApiUsageFilters = {
      q: "",
      method: "",
      path: "",
      apiKeyId: "",
      statusBuckets: [],
      from: "",
      to: "",
    };
    setDraft(cleared);
    setFilters(cleared);
  };
  const filtersAreModified = Boolean(
    filters.q ||
      filters.method ||
      filters.path ||
      filters.apiKeyId ||
      filters.statusBuckets.length > 0 ||
      filters.from ||
      filters.to,
  );

  // Build filter-preserving export URL.
  const exportParams = new URLSearchParams();
  if (filters.q) exportParams.set("q", filters.q);
  if (filters.method) exportParams.set("method", filters.method);
  if (filters.path) exportParams.set("path", filters.path);
  if (filters.apiKeyId) exportParams.set("api_key_id", filters.apiKeyId);
  if (filters.statusBuckets.length > 0) {
    exportParams.set("status", filters.statusBuckets.join(","));
  }
  if (filters.from) exportParams.set("created_at_gte", filters.from);
  if (filters.to) exportParams.set("created_at_lte", filters.to);
  const exportHref = `/admin/api-usage/export${
    exportParams.toString() ? `?${exportParams.toString()}` : ""
  }`;

  const toggleStatusBucket = (bucket: string) => {
    setDraft((prev) => {
      const has = prev.statusBuckets.includes(bucket);
      const next = {
        ...prev,
        statusBuckets: has
          ? prev.statusBuckets.filter((s) => s !== bucket)
          : [...prev.statusBuckets, bucket],
      };
      return next;
    });
  };

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
          placeholder="action / error / key name"
          className="h-11 min-w-[220px] rounded-md border border-border bg-input px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:h-9 md:py-1.5"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Path contains
        <input
          type="text"
          value={draft.path}
          onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          placeholder="/api/v1/leads"
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Method
        <select
          value={draft.method}
          onChange={(e) => setDraft({ ...draft, method: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Any</option>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        API key
        <select
          value={draft.apiKeyId}
          onChange={(e) => setDraft({ ...draft, apiKeyId: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Any</option>
          {apiKeyOptions.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name} ({k.prefix}){k.revoked ? " — revoked" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        From
        <input
          type="date"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        To
        <input
          type="date"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </label>
      <fieldset className="flex flex-col gap-1 text-xs text-muted-foreground">
        <legend className="text-xs text-muted-foreground">Status</legend>
        <div className="flex gap-1.5">
          {STATUS_BUCKETS.map((b) => {
            const active = draft.statusBuckets.includes(b.value);
            return (
              <button
                key={b.value}
                type="button"
                onClick={() => toggleStatusBucket(b.value)}
                className={cn(
                  "inline-flex h-11 cursor-pointer items-center rounded-full border px-3 text-sm font-medium transition md:h-8 md:py-1.5 md:text-xs",
                  active
                    ? statusBucketActiveClass(b.value)
                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60",
                )}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      </fieldset>
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
    <StandardListPage<ApiUsageRow, ApiUsageFilters>
      queryKey={["admin-api-usage"]}
      fetchPage={fetchPage}
      filters={memoizedFilters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={72}
      cardEstimateSize={160}
      pageSize={100}
      emptyState={
        <StandardEmptyState
          title="No API requests match"
          description={
            filtersAreModified ? "Reset the filters to see all requests." : undefined
          }
        />
      }
      header={{
        title: "API usage",
        description: "Bearer-token-authenticated requests against the public API.",
      }}
      filtersSlot={filtersSlot}
    />
  );
}

function ApiUsageDesktopRow({
  row,
  timePrefs,
}: {
  row: ApiUsageRow;
  timePrefs: TimePrefs;
}) {
  const detailHasContent =
    row.requestQuery ||
    row.requestBodySummary ||
    row.responseSummary ||
    row.errorMessage ||
    row.userAgent;
  return (
    <div
      className="flex items-start gap-4 border-b border-border bg-card px-4 py-3 text-sm"
      data-row-flash="new"
    >
      <div className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">
        <UserTimeClient
          value={row.createdAt}
          prefs={timePrefs}
          mode="relative"
        />
        <div
          className="text-[10px] text-muted-foreground/70"
          title={row.createdAt}
        >
          <UserTimeClient value={row.createdAt} prefs={timePrefs} />
        </div>
      </div>
      <div className="w-32 shrink-0 text-xs">
        <Link
          href={`/admin/api-usage?api_key_id=${row.apiKeyId ?? ""}`}
          className="text-foreground/90 hover:underline"
          title="Filter to just this key"
        >
          {row.apiKeyNameSnapshot}
        </Link>
        <div className="font-mono text-[10px] text-muted-foreground/70">
          {row.apiKeyPrefixSnapshot}
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 text-xs md:block">
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
            methodChipClass(row.method),
          )}
        >
          {row.method}
        </span>{" "}
        <span className="font-mono text-foreground/90">{row.path}</span>
        {row.action ? (
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {row.action}
          </span>
        ) : null}
      </div>
      <div className="w-36 shrink-0 text-xs">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
            statusChipClass(row.statusCode),
          )}
          title={statusOutcomeTitle(row.statusCode)}
        >
          <span>{statusOutcomeLabel(row.statusCode)}</span>
          <span className="font-mono opacity-70">· {row.statusCode}</span>
        </span>
      </div>
      <div className="hidden w-20 shrink-0 text-xs text-muted-foreground tabular-nums lg:block">
        {row.responseTimeMs == null ? "—" : `${row.responseTimeMs} ms`}
      </div>
      <div className="hidden w-32 shrink-0 font-mono text-[10px] text-muted-foreground lg:block">
        {row.ipAddress ?? "—"}
      </div>
      <div className="hidden w-24 shrink-0 text-xs xl:block">
        {detailHasContent ? <DetailCell row={row} /> : "—"}
      </div>
    </div>
  );
}

function ApiUsageMobileCard({
  row,
  timePrefs,
}: {
  row: ApiUsageRow;
  timePrefs: TimePrefs;
}) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
      data-row-flash="new"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <UserTimeClient value={row.createdAt} prefs={timePrefs} />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold",
            statusChipClass(row.statusCode),
          )}
        >
          {row.statusCode}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
            methodChipClass(row.method),
          )}
        >
          {row.method}
        </span>
        <span className="truncate font-mono text-foreground/90">{row.path}</span>
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {row.apiKeyNameSnapshot}{" "}
        <span className="font-mono">{row.apiKeyPrefixSnapshot}</span>
      </div>
      {row.errorMessage ? (
        <div className="truncate text-xs text-muted-foreground/90">
          {row.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

function DetailCell({ row }: { row: ApiUsageRow }) {
  return (
    <details className="w-[280px] max-w-[280px]">
      <summary className="cursor-pointer text-foreground/80 underline-offset-4 hover:underline">
        view
      </summary>
      <pre className="mt-2 max-h-64 w-[280px] max-w-[280px] overflow-y-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[10px] text-foreground/90">
        {JSON.stringify(
          {
            request_query: row.requestQuery,
            request_body_summary: row.requestBodySummary,
            response_summary: row.responseSummary,
            error_code: row.errorCode,
            error_message: row.errorMessage,
            user_agent: row.userAgent,
          },
          null,
          2,
        )}
      </pre>
    </details>
  );
}

function statusChipClass(code: number): string {
  if (code >= 500)
    return "bg-red-500/15 text-red-400 ring-1 ring-inset ring-red-500/30";
  if (code >= 400)
    return "bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/30";
  if (code >= 300)
    return "bg-muted/60 text-muted-foreground ring-1 ring-inset ring-border";
  if (code >= 200)
    return "bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/30";
  return "bg-muted/40 text-muted-foreground";
}

function statusOutcomeLabel(code: number): string {
  if (code >= 500) return "Server error";
  if (code >= 400) return "Blocked";
  if (code >= 300) return "Redirected";
  if (code >= 200) return "Allowed";
  return "Unknown";
}

function statusOutcomeTitle(code: number): string {
  if (code >= 500)
    return `Server error (${code}) — the request reached the server but the handler threw. Look in the Detail column for the error message.`;
  if (code >= 400)
    return `Blocked (${code}) — the request was rejected at an auth, permission, or validation gate. No data was created, updated, or deleted.`;
  if (code >= 300)
    return `Redirected (${code}) — the server returned a redirect response. No data was created, updated, or deleted.`;
  if (code >= 200)
    return `Allowed (${code}) — the request succeeded. Any mutation it performed is in the audit log.`;
  return `Unknown status (${code}).`;
}

function statusBucketActiveClass(bucket: string): string {
  switch (bucket) {
    case "5xx":
      return "border-red-500/40 bg-red-500/15 text-red-400";
    case "4xx":
      return "border-amber-500/40 bg-amber-500/15 text-amber-400";
    case "3xx":
      return "border-border bg-muted/60 text-foreground";
    case "2xx":
    default:
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-400";
  }
}

function methodChipClass(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "bg-sky-500/15 text-sky-400 ring-1 ring-inset ring-sky-500/30";
    case "POST":
      return "bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/30";
    case "PATCH":
    case "PUT":
      return "bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/30";
    case "DELETE":
      return "bg-red-500/15 text-red-400 ring-1 ring-inset ring-red-500/30";
    default:
      return "bg-muted/60 text-muted-foreground";
  }
}
