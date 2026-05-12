import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, apiUsageLog } from "@/db/schema/api-keys";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { RetentionBanner } from "@/components/admin/retention-banner";
import { UserTime } from "@/components/ui/user-time";
import { encodeCursor, parseCursor } from "@/lib/leads";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
const STATUS_BUCKETS = [
  { value: "2xx", label: "2xx", min: 200, max: 299 },
  { value: "3xx", label: "3xx", min: 300, max: 399 },
  { value: "4xx", label: "4xx", min: 400, max: 499 },
  { value: "5xx", label: "5xx", min: 500, max: 599 },
] as const;

interface ApiUsageSearchParams {
  q?: string;
  method?: string;
  path?: string;
  /** Either repeated (`?status=2xx&status=4xx`) when checkbox group is
   * serialized by the browser, or a single comma-separated string
   * when copy-pasted from the export URL. */
  status?: string | string[];
  api_key_id?: string | string[];
  created_at_gte?: string;
  created_at_lte?: string;
  cursor?: string;
}

export default async function ApiUsageLogPage({
  searchParams,
}: {
  searchParams: Promise<ApiUsageSearchParams>;
}) {
  const sp = await searchParams;

  // Default to the last 7 days when no explicit range is supplied. Both
  // sides default-fill so the URL is shareable and the user can clear
  // the dates by clicking Reset.
  const defaultGte = isoDateOnly(daysAgo(7));
  const defaultLte = isoDateOnly(new Date());
  const effectiveGte = sp.created_at_gte ?? defaultGte;
  const effectiveLte = sp.created_at_lte ?? defaultLte;

  const selectedKeyIds = parseList(sp.api_key_id);
  const selectedStatusBuckets = parseList(sp.status).filter((s) =>
    STATUS_BUCKETS.some((b) => b.value === s),
  );
  // The form serializes status checkboxes as repeated `status=` keys.
  // Normalize back to a single comma-separated string so cursor/export
  // links round-trip cleanly.
  const statusParam = selectedStatusBuckets.join(",") || undefined;
  const apiKeyIdParam = selectedKeyIds.join(",") || undefined;

  // Build WHERE clauses.
  const wheres = buildWhereClauses({
    q: sp.q,
    method: sp.method,
    path: sp.path,
    statusBuckets: selectedStatusBuckets,
    apiKeyIds: selectedKeyIds,
    createdAtGte: effectiveGte,
    createdAtLte: effectiveLte,
  });

  const cursor = parseCursor(sp.cursor);
  if (cursor && cursor.ts) {
    wheres.push(
      sql`(
        ${apiUsageLog.createdAt} < ${cursor.ts.toISOString()}::timestamptz
        OR (${apiUsageLog.createdAt} = ${cursor.ts.toISOString()}::timestamptz AND ${apiUsageLog.id} < ${cursor.id}::uuid)
      )`,
    );
  }
  const where = wheres.length > 0 ? and(...wheres) : undefined;

  if (sp.q && sp.q.trim()) {
    await db.execute(sql`SET LOCAL statement_timeout = '5s'`);
  }

  const [rowsRaw, keyRows] = await Promise.all([
    db
      .select({
        id: apiUsageLog.id,
        createdAt: apiUsageLog.createdAt,
        apiKeyId: apiUsageLog.apiKeyId,
        apiKeyNameSnapshot: apiUsageLog.apiKeyNameSnapshot,
        apiKeyPrefixSnapshot: apiUsageLog.apiKeyPrefixSnapshot,
        method: apiUsageLog.method,
        path: apiUsageLog.path,
        action: apiUsageLog.action,
        statusCode: apiUsageLog.statusCode,
        responseTimeMs: apiUsageLog.responseTimeMs,
        ipAddress: apiUsageLog.ipAddress,
        userAgent: apiUsageLog.userAgent,
        requestQuery: apiUsageLog.requestQuery,
        requestBodySummary: apiUsageLog.requestBodySummary,
        responseSummary: apiUsageLog.responseSummary,
        errorCode: apiUsageLog.errorCode,
        errorMessage: apiUsageLog.errorMessage,
      })
      .from(apiUsageLog)
      .where(where)
      .orderBy(desc(apiUsageLog.createdAt), desc(apiUsageLog.id))
      .limit(PAGE_SIZE + 1),
    db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.keyPrefix,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .orderBy(asc(apiKeys.name)),
  ]);

  const hasMore = rowsRaw.length > PAGE_SIZE;
  const rows = hasMore ? rowsRaw.slice(0, PAGE_SIZE) : rowsRaw;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  // Build the filter-preserving export URL.
  const exportParams = filterParams({
    q: sp.q,
    method: sp.method,
    path: sp.path,
    status: statusParam,
    api_key_id: apiKeyIdParam,
    created_at_gte: effectiveGte,
    created_at_lte: effectiveLte,
  });
  const exportHref = `/admin/api-usage/export${
    exportParams.toString() ? `?${exportParams.toString()}` : ""
  }`;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "API Usage" },
        ]}
      />
      <h1 className="text-2xl font-semibold">API usage</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Showing {rows.length}
        {nextCursor ? "+" : ""} {rows.length === 1 ? "request" : "requests"} from {effectiveGte} to {effectiveLte}.
      </p>

      <div className="mt-6">
        <RetentionBanner days={730} label="API usage logs" />
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Search
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="action / error / key name…"
            className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 sm:w-auto sm:min-w-[240px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Path contains
          <input
            name="path"
            defaultValue={sp.path ?? ""}
            placeholder="/api/v1/leads"
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Method
          <select
            name="method"
            defaultValue={sp.method ?? ""}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
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
            name="api_key_id"
            defaultValue={selectedKeyIds[0] ?? ""}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="">Any</option>
            {keyRows.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.prefix})
                {k.revokedAt ? " — revoked" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <input
            type="date"
            name="created_at_gte"
            defaultValue={effectiveGte}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <input
            type="date"
            name="created_at_lte"
            defaultValue={effectiveLte}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
        {/* Hidden field that materializes the status chips into a
            single comma-separated query param. The chips are
            checkboxes named `status` so the form serializes
            naturally; we don't actually need a hidden field. */}
        <fieldset className="flex flex-col gap-1 text-xs text-muted-foreground">
          <legend className="text-xs text-muted-foreground">Status</legend>
          <div className="flex gap-1.5">
            {STATUS_BUCKETS.map((b) => {
              const active = selectedStatusBuckets.includes(b.value);
              return (
                <label
                  key={b.value}
                  className={cn(
                    "inline-flex cursor-pointer items-center rounded-full border px-3 py-1.5 text-xs font-medium transition",
                    active
                      ? statusBucketActiveClass(b.value)
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <input
                    type="checkbox"
                    name="status"
                    value={b.value}
                    defaultChecked={active}
                    className="sr-only"
                  />
                  {b.label}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
          >
            Apply
          </button>
          <a
            href="/admin/api-usage"
            className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
          >
            Reset
          </a>
          <a
            href={exportHref}
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
            title="Download up to 50,000 matching rows as CSV"
          >
            Export CSV
          </a>
        </div>
      </form>

      {/* Horizontal scroll on mid-range / mobile viewports — at <1000px the
          8-column forensic table would otherwise clip Latency / IP / Detail
          on the right. The wrapper keeps the rounded chrome; the inner
          table sets a min-width so columns don't squash. Mirrors the
          existing pattern for dense admin log tables (audit log). */}
      <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-muted/40 backdrop-blur-xl">
        <table className="data-table min-w-[1000px] divide-y divide-border/60 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">When</th>
              <th className="px-5 py-3 font-medium">Key</th>
              <th className="px-5 py-3 font-medium">Method · Path</th>
              <th className="px-5 py-3 font-medium">Action</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Latency</th>
              <th className="px-5 py-3 font-medium">IP</th>
              <th className="px-5 py-3 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-muted-foreground">
                  No API requests match.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => {
              const detailHasContent =
                r.requestQuery ||
                r.requestBodySummary ||
                r.responseSummary ||
                r.errorMessage ||
                r.userAgent;
              const keyHref = filterByKeyHref(
                sp,
                effectiveGte,
                effectiveLte,
                r.apiKeyId,
                statusParam,
              );
              return (
                <tr key={r.id} className="align-top">
                  <td className="px-5 py-3 text-xs text-muted-foreground tabular-nums">
                    <UserTime value={r.createdAt} mode="relative" />
                    <div
                      className="text-[10px] text-muted-foreground/70"
                      title={
                        r.createdAt instanceof Date
                          ? r.createdAt.toISOString()
                          : String(r.createdAt ?? "")
                      }
                    >
                      <UserTime value={r.createdAt} />
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs">
                    {keyHref ? (
                      <a
                        href={keyHref}
                        className="text-foreground/90 underline-offset-4 hover:underline"
                        title="Filter to just this key"
                      >
                        {r.apiKeyNameSnapshot}
                      </a>
                    ) : (
                      <span className="text-foreground/90">{r.apiKeyNameSnapshot}</span>
                    )}
                    <div className="font-mono text-[10px] text-muted-foreground/70">
                      {r.apiKeyPrefixSnapshot}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs">
                    <span
                      className={cn(
                        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
                        methodChipClass(r.method),
                      )}
                    >
                      {r.method}
                    </span>{" "}
                    <span className="font-mono text-foreground/90">{r.path}</span>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                    {r.action ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-xs">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        statusChipClass(r.statusCode),
                      )}
                      title={statusOutcomeTitle(r.statusCode)}
                    >
                      <span>{statusOutcomeLabel(r.statusCode)}</span>
                      <span className="font-mono opacity-70">
                        · {r.statusCode}
                      </span>
                    </span>
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground tabular-nums">
                    {r.responseTimeMs == null ? "—" : `${r.responseTimeMs} ms`}
                  </td>
                  <td className="px-5 py-3 font-mono text-[10px] text-muted-foreground">
                    {r.ipAddress ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground align-top">
                    {detailHasContent ? (
                      <details className="w-[280px] max-w-[280px]">
                        <summary className="cursor-pointer text-foreground/80 underline-offset-4 hover:underline">
                          view
                        </summary>
                        <pre className="mt-2 max-h-64 w-[280px] max-w-[280px] overflow-y-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[10px] text-foreground/90">
                          {JSON.stringify(
                            {
                              request_query: r.requestQuery,
                              request_body_summary: r.requestBodySummary,
                              response_summary: r.responseSummary,
                              error_code: r.errorCode,
                              error_message: r.errorMessage,
                              user_agent: r.userAgent,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {nextCursor || sp.cursor ? (
        <nav className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>{sp.cursor ? "Showing more results" : `Showing first ${PAGE_SIZE}`}</span>
          <div className="flex gap-2">
            {sp.cursor ? (
              <CursorLink
                sp={sp}
                cursor={null}
                effectiveGte={effectiveGte}
                effectiveLte={effectiveLte}
                statusParam={statusParam}
                apiKeyIdParam={apiKeyIdParam}
              >
                ← Back to start
              </CursorLink>
            ) : null}
            {nextCursor ? (
              <CursorLink
                sp={sp}
                cursor={nextCursor}
                effectiveGte={effectiveGte}
                effectiveLte={effectiveLte}
                statusParam={statusParam}
                apiKeyIdParam={apiKeyIdParam}
              >
                Load more →
              </CursorLink>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

interface FilterInput {
  q?: string;
  method?: string;
  path?: string;
  statusBuckets?: string[];
  apiKeyIds?: string[];
  createdAtGte?: string;
  createdAtLte?: string;
}

function buildWhereClauses(f: FilterInput) {
  const wheres: ReturnType<typeof and>[] = [];

  if (f.q && f.q.trim()) {
    const pattern = `%${f.q.trim()}%`;
    wheres.push(
      or(
        ilike(apiUsageLog.action, pattern),
        ilike(apiUsageLog.errorMessage, pattern),
        ilike(apiUsageLog.apiKeyNameSnapshot, pattern),
      ),
    );
  }
  if (f.method) wheres.push(eq(apiUsageLog.method, f.method));
  if (f.path && f.path.trim()) {
    wheres.push(ilike(apiUsageLog.path, `%${f.path.trim()}%`));
  }
  if (f.statusBuckets && f.statusBuckets.length > 0) {
    const ranges = f.statusBuckets
      .map((bucket) => STATUS_BUCKETS.find((b) => b.value === bucket))
      .filter((b): b is (typeof STATUS_BUCKETS)[number] => Boolean(b));
    if (ranges.length > 0) {
      const ors = ranges.map(
        (b) =>
          sql`(${apiUsageLog.statusCode} >= ${b.min} AND ${apiUsageLog.statusCode} <= ${b.max})`,
      );
      wheres.push(or(...ors));
    }
  }
  if (f.apiKeyIds && f.apiKeyIds.length > 0) {
    wheres.push(inArray(apiUsageLog.apiKeyId, f.apiKeyIds));
  }
  if (f.createdAtGte) {
    const d = new Date(f.createdAtGte);
    if (!Number.isNaN(d.getTime())) wheres.push(gte(apiUsageLog.createdAt, d));
  }
  if (f.createdAtLte) {
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(f.createdAtLte);
    const d = isDateOnly
      ? new Date(`${f.createdAtLte}T23:59:59.999Z`)
      : new Date(f.createdAtLte);
    if (!Number.isNaN(d.getTime())) wheres.push(lte(apiUsageLog.createdAt, d));
  }
  return wheres.filter(Boolean);
}

function statusChipClass(code: number): string {
  if (code >= 500) return "bg-red-500/15 text-red-400 ring-1 ring-inset ring-red-500/30";
  if (code >= 400) return "bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/30";
  if (code >= 300) return "bg-muted/60 text-muted-foreground ring-1 ring-inset ring-border";
  if (code >= 200) return "bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/30";
  return "bg-muted/40 text-muted-foreground";
}

/**
 * Plain-English outcome label paired with the HTTP status code so
 * "401" doesn't read ambiguously. A 4xx specifically means the
 * request was REJECTED at an auth / validation gate before any
 * database mutation ran — nothing was created, updated, or deleted.
 */
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

function parseList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function filterParams(filters: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) params.set(k, v);
  }
  return params;
}

function filterByKeyHref(
  sp: ApiUsageSearchParams,
  gte: string,
  lte: string,
  keyId: string | null,
  statusParam: string | undefined,
): string | null {
  if (!keyId) return null;
  const params = new URLSearchParams();
  if (sp.q) params.set("q", sp.q);
  if (sp.method) params.set("method", sp.method);
  if (sp.path) params.set("path", sp.path);
  if (statusParam) params.set("status", statusParam);
  params.set("api_key_id", keyId);
  params.set("created_at_gte", gte);
  params.set("created_at_lte", lte);
  return `/admin/api-usage?${params.toString()}`;
}

function CursorLink({
  sp,
  cursor,
  effectiveGte,
  effectiveLte,
  statusParam,
  apiKeyIdParam,
  children,
}: {
  sp: ApiUsageSearchParams;
  cursor: string | null;
  effectiveGte: string;
  effectiveLte: string;
  statusParam: string | undefined;
  apiKeyIdParam: string | undefined;
  children: React.ReactNode;
}) {
  const params = new URLSearchParams();
  if (sp.q) params.set("q", sp.q);
  if (sp.method) params.set("method", sp.method);
  if (sp.path) params.set("path", sp.path);
  if (statusParam) params.set("status", statusParam);
  if (apiKeyIdParam) params.set("api_key_id", apiKeyIdParam);
  params.set("created_at_gte", effectiveGte);
  params.set("created_at_lte", effectiveLte);
  if (cursor) params.set("cursor", cursor);
  return (
    <a
      href={`/admin/api-usage?${params.toString()}`}
      className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
    >
      {children}
    </a>
  );
}

function isoDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
