import Link from "next/link";
import { redirect } from "next/navigation";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { formatUserTime, type TimePrefs } from "@/lib/format-time";
import {
  getPermissions,
  requireSession,
  type SessionUser,
} from "@/lib/auth-helpers";
import { canDeleteLead } from "@/lib/access/can-delete";
import { StatusPill } from "@/components/ui/status-pill";
import { PriorityPill } from "@/components/ui/priority-pill";
import { UserChip } from "@/components/user-display";
import { LeadRowActions } from "./_components/lead-row-actions";
import {
  AVAILABLE_COLUMNS,
  type ColumnKey,
  COLUMN_KEYS,
  DEFAULT_COLUMNS,
  findBuiltinView,
  getPreferences,
  getSavedView,
  listSavedViewsForUser,
  type LeadRow,
  runView,
  type ViewDefinition,
  visibleBuiltins,
} from "@/lib/views";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";
import { ViewToolbar, type ViewSummary } from "./view-toolbar";

export const dynamic = "force-dynamic";

interface SearchParams {
  view?: string;
  q?: string;
  status?: string;
  rating?: string;
  source?: string;
  tag?: string;
  page?: string;
  cols?: string;
  sort?: string;
  dir?: string;
  // Phase 9C — cursor pagination on the default sort. When present,
  // `page=` is ignored and the next cursor is read from `result.nextCursor`.
  cursor?: string;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(user.id);
  const timePrefs = await getCurrentUserTimePrefs();
  const canViewAll = user.isAdmin || perms.canViewAllRecords;

  // ---- Resolve active view -----------------------------------------------
  // Phase 5A precedence:
  //   1. ?view= explicit
  //   2. user_preferences.default_leads_view_id (the "stick this view" pref)
  //   3. user_preferences.last_used_view_id (drives "remember where I was")
  //   4. fallback to builtin:my-open
  const prefs = await getPreferences(user.id);
  let activeViewParam = sp.view;
  if (!activeViewParam && prefs.defaultLeadsViewId) {
    activeViewParam = `saved:${prefs.defaultLeadsViewId}`;
  }
  if (!activeViewParam && prefs.lastUsedViewId) {
    activeViewParam = `saved:${prefs.lastUsedViewId}`;
  }
  if (!activeViewParam) activeViewParam = "builtin:my-open";

  const savedViews = await listSavedViewsForUser(user.id);

  let activeView: ViewDefinition | null = null;
  if (activeViewParam.startsWith("saved:")) {
    const id = activeViewParam.slice("saved:".length);
    activeView = await getSavedView(user.id, id);
    if (!activeView) {
      // Stored last-used pointed at a deleted view — bail to default.
      redirect("/leads?view=builtin:my-open");
    }
  } else {
    activeView = findBuiltinView(activeViewParam);
    if (activeView?.requiresAllLeads && !canViewAll) {
      // Stripped quietly — not our place to leak that it exists.
      activeView = findBuiltinView("builtin:my-open");
    }
    if (!activeView) activeView = findBuiltinView("builtin:my-open");
  }
  if (!activeView) {
    redirect("/leads?view=builtin:my-open");
  }

  // ---- Build the URL filter overlay --------------------------------------
  // The visible filter form (q/status/rating/source/tag) overlays the view
  // base — empty values fall through.
  const extraFilters = {
    search: sp.q || undefined,
    status: sp.status ? [sp.status] : undefined,
    rating: sp.rating ? [sp.rating] : undefined,
    source: sp.source ? [sp.source] : undefined,
    tags: sp.tag ? [sp.tag] : undefined,
  };

  // ---- Resolve column list -----------------------------------------------
  // URL ?cols= wins, then prefs.adhoc_columns (only on builtin views), else
  // the view's stored column list.
  const baseColumns = activeView.columns;
  const urlCols = sp.cols
    ? (sp.cols.split(",").filter((c): c is ColumnKey => COLUMN_KEYS.includes(c as ColumnKey)) as ColumnKey[])
    : null;
  let activeColumns: ColumnKey[];
  if (urlCols && urlCols.length > 0) {
    activeColumns = urlCols;
  } else if (activeView.source === "builtin" && prefs.adhocColumns?.length) {
    activeColumns = prefs.adhocColumns;
  } else {
    activeColumns = baseColumns;
  }

  // Page / sort handling. ?sort + ?dir override view defaults.
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const pageSize = 50;
  const sort = sp.sort
    ? {
        field: (sp.sort as never) ?? "lastActivityAt",
        direction: (sp.dir === "asc" ? "asc" : "desc") as "asc" | "desc",
      }
    : undefined;

  // ---- Run the query -----------------------------------------------------
  // Phase 9C — cursor wins when present and the active sort is the
  // default (lastActivityAt DESC). Custom sorts continue using offset
  // paging because we don't have composite (col, id) indexes for every
  // sortable column.
  const result = await runView({
    view: activeView,
    user,
    canViewAll,
    page,
    pageSize,
    columns: activeColumns,
    sort,
    extraFilters,
    cursor: sp.cursor,
  });

  // ---- Toolbar payload ---------------------------------------------------
  const allViews: ViewSummary[] = [
    ...visibleBuiltins(canViewAll).map((v) => ({
      id: v.id,
      name: v.name,
      source: v.source,
      scope: v.scope,
    })),
    ...savedViews.map((v) => ({
      id: v.id,
      name: v.name,
      source: v.source,
      scope: v.scope,
      version: v.version,
    })),
  ];

  const columnsModified =
    activeColumns.length !== baseColumns.length ||
    activeColumns.some((c, i) => baseColumns[i] !== c);

  const savedDirtyId = activeView.source === "saved" ? activeView.id : null;

  return (
    <div className="px-10 py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Leads" }]} />
      <PagePoll entities={["leads"]} />
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {/* Phase 9C — cursor pagination skips the COUNT query for
                speed at scale. We show the row count only when the
                offset path runs (custom sort or filtered view). */}
            {result.total > 0
              ? `${result.total} ${result.total === 1 ? "lead" : "leads"}`
              : `${result.rows.length}${result.nextCursor ? "+" : ""} ${result.rows.length === 1 ? "lead" : "leads"}`}
            {sp.q ? ` matching "${sp.q}"` : ""} · view {activeView.name}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex gap-1 rounded-lg border border-glass-border bg-glass-1 p-1">
            <span className="rounded bg-primary/20 px-3 py-1.5 text-xs font-medium text-foreground">
              Table
            </span>
            <Link
              href="/leads/pipeline"
              className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Pipeline
            </Link>
          </div>
          {perms.canImport || user.isAdmin ? (
            <Link
              href="/leads/import"
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
            >
              Import
            </Link>
          ) : null}
          {perms.canExport || user.isAdmin ? (
            <a
              href={buildExportHref(sp)}
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
            >
              Export
            </a>
          ) : null}
          {perms.canCreateLeads || user.isAdmin ? (
            <Link
              href="/leads/new"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              + Add lead
            </Link>
          ) : null}
        </div>
      </div>

      <div className="mt-5">
        <ViewToolbar
          views={allViews}
          activeViewId={activeViewParam}
          activeColumns={activeColumns}
          baseColumns={baseColumns}
          savedDirtyId={savedDirtyId}
          columnsModified={columnsModified}
        />
      </div>

      <form
        action="/leads"
        method="get"
        className="mt-5 flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="view" value={activeViewParam} />
        <input
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="Search name / email / company / phone…"
          className="min-w-[240px] flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <FilterSelect
          name="status"
          defaultValue={sp.status}
          options={LEAD_STATUSES}
          placeholder="Status"
        />
        <FilterSelect
          name="rating"
          defaultValue={sp.rating}
          options={LEAD_RATINGS}
          placeholder="Rating"
        />
        <FilterSelect
          name="source"
          defaultValue={sp.source}
          options={LEAD_SOURCES}
          placeholder="Source"
        />
        <button
          type="submit"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
        >
          Apply
        </button>
        {sp.q || sp.status || sp.rating || sp.source || sp.tag ? (
          <Link
            href={`/leads?view=${encodeURIComponent(activeViewParam)}`}
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground/90"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-muted/40 backdrop-blur-xl">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              {activeColumns.map((c) => (
                <th key={c} className="px-5 py-3 font-medium whitespace-nowrap">
                  {AVAILABLE_COLUMNS.find((col) => col.key === c)?.label ?? c}
                </th>
              ))}
              {/* Phase 10 — fixed-width trailing actions cell. */}
              <th className="w-10 px-2 py-3" aria-label="actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {result.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={activeColumns.length + 1}
                  className="px-5 py-12 text-center text-muted-foreground"
                >
                  No leads match this view.
                </td>
              </tr>
            ) : null}
            {result.rows.map((l) => (
              // Phase 10 — `group` enables hover-revealed trash icon
              // on desktop. The trailing cell stays in the layout
              // regardless so column widths don't shift on hover.
              <tr key={l.id} className="group transition hover:bg-muted/40">
                {activeColumns.map((c) => (
                  <td key={c} className="px-5 py-3 align-top">
                    {renderCell(l, c, timePrefs)}
                  </td>
                ))}
                <td className="w-10 px-2 py-3 align-top">
                  <LeadRowActions
                    leadId={l.id}
                    leadName={leadDisplayName(l)}
                    canDelete={canDeleteLead(user as SessionUser, { ownerId: l.ownerId })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.nextCursor || sp.cursor ? (
        // Phase 9C — cursor pagination path (default sort). "Load more"
        // appears whenever a nextCursor exists; "Back to start"
        // appears once the user has advanced past the first batch.
        <CursorNav nextCursor={result.nextCursor} sp={sp} />
      ) : result.total > pageSize ? (
        // Custom-sort fallback path — offset pagination keeps the
        // existing "Page X of Y" UX for sorts that don't have a
        // composite index yet.
        <Pagination
          page={page}
          pageSize={pageSize}
          total={result.total}
          searchParams={sp}
        />
      ) : null}
    </div>
  );
}

function CursorNav({
  nextCursor,
  sp,
}: {
  nextCursor: string | null;
  sp: SearchParams;
}) {
  const buildHref = (next: string | null) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "cursor" || k === "page") continue;
      if (typeof v === "string" && v.length > 0) params.set(k, v);
    }
    if (next) params.set("cursor", next);
    return `/leads?${params.toString()}`;
  };
  return (
    <nav className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
      <span>{sp.cursor ? "Showing more results" : "Showing first page"}</span>
      <div className="flex gap-2">
        {sp.cursor ? (
          <Link
            href={buildHref(null)}
            className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
          >
            ← Back to start
          </Link>
        ) : null}
        {nextCursor ? (
          <Link
            href={buildHref(nextCursor)}
            className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
          >
            Load more →
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

function leadDisplayName(l: LeadRow): string {
  const name = `${l.firstName ?? ""} ${l.lastName ?? ""}`.trim();
  return name || l.companyName || l.email || "this lead";
}

function buildExportHref(sp: SearchParams): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && v.length > 0) params.set(k, v);
  }
  return `/api/leads/export?${params.toString()}`;
}

function renderCell(lead: LeadRow, col: ColumnKey, prefs: TimePrefs) {
  switch (col) {
    case "firstName":
      return (
        <Link
          href={`/leads/${lead.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {lead.firstName}
        </Link>
      );
    case "lastName":
      return lead.lastName ? (
        <Link
          href={`/leads/${lead.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {lead.lastName}
        </Link>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "companyName":
      return <span className="text-foreground/80">{lead.companyName ?? "—"}</span>;
    case "email":
      return <span className="text-muted-foreground">{lead.email ?? "—"}</span>;
    case "phone":
      return <span className="text-muted-foreground">{lead.phone ?? "—"}</span>;
    case "mobilePhone":
      return <span className="text-muted-foreground">{lead.mobilePhone ?? "—"}</span>;
    case "jobTitle":
      return <span className="text-muted-foreground">{lead.jobTitle ?? "—"}</span>;
    case "status":
      return <StatusPill status={lead.status} />;
    case "rating":
      return <PriorityPill priority={lead.rating} />;
    case "source":
      return <Pill kind="source" value={lead.source} />;
    case "owner":
      // Phase 9C — UserChip in lieu of plain text. Skip hoverCard:
      // table can render up to 50 rows, and server-rendering 50
      // hover cards is too expensive even with the in-process cache.
      // Initials fallback when ownerPhotoUrl isn't projected — the
      // /users/[id] click-through still resolves the full profile.
      return lead.ownerId ? (
        <UserChip
          user={{
            id: lead.ownerId,
            displayName: lead.ownerDisplayName,
            photoUrl: null,
          }}
        />
      ) : (
        <span className="text-muted-foreground">Unassigned</span>
      );
    case "tags":
      return (
        <span className="text-xs text-muted-foreground">
          {lead.tags?.length ? lead.tags.join(", ") : "—"}
        </span>
      );
    case "city":
      return <span className="text-muted-foreground">{lead.city ?? "—"}</span>;
    case "state":
      return <span className="text-muted-foreground">{lead.state ?? "—"}</span>;
    case "estimatedValue":
      return (
        <span className="tabular-nums text-muted-foreground">
          {lead.estimatedValue ? `$${Number(lead.estimatedValue).toLocaleString()}` : "—"}
        </span>
      );
    case "estimatedCloseDate":
      return (
        <span className="text-muted-foreground">
          {lead.estimatedCloseDate ?? "—"}
        </span>
      );
    case "createdBy":
      return lead.createdById ? (
        <UserChip
          user={{
            id: lead.createdById,
            displayName: lead.createdByDisplayName,
            photoUrl: null,
          }}
        />
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "createdVia":
      return <Pill kind="provenance" value={lead.createdVia} />;
    case "createdAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(lead.createdAt, prefs, "date")}
        </span>
      );
    case "lastActivityAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(lead.lastActivityAt, prefs)}
        </span>
      );
    case "updatedAt":
      return (
        <span className="text-muted-foreground">
          {formatUserTime(lead.updatedAt, prefs)}
        </span>
      );
    default:
      return null;
  }
}

function Pill({
  kind,
  value,
}: {
  kind: "status" | "rating" | "source" | "provenance";
  value: string;
}) {
  const palette: Record<string, Record<string, string>> = {
    status: {
      new: "border-blue-500/30 dark:border-blue-300/30 bg-blue-500/20 dark:bg-blue-500/15 dark:bg-blue-500/10 text-blue-700 dark:text-blue-100",
      contacted: "border-cyan-500/30 dark:border-cyan-300/30 bg-cyan-500/20 dark:bg-cyan-500/15 dark:bg-cyan-500/10 text-cyan-700 dark:text-cyan-100",
      qualified: "border-emerald-500/30 dark:border-emerald-300/30 bg-emerald-500/20 dark:bg-emerald-500/15 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100",
      unqualified: "border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 text-rose-700 dark:text-rose-100",
      converted: "border-violet-500/30 dark:border-violet-300/30 bg-violet-500/20 dark:bg-violet-500/15 dark:bg-violet-500/10 text-violet-700 dark:text-violet-100",
      lost: "border-border bg-muted/40 text-muted-foreground/80",
    },
    rating: {
      hot: "border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 text-rose-700 dark:text-rose-100",
      warm: "border-amber-500/30 dark:border-amber-300/30 bg-amber-500/20 dark:bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-100",
      cold: "border-sky-500/30 dark:border-sky-300/30 bg-sky-500/20 dark:bg-sky-500/15 dark:bg-sky-500/10 text-sky-700 dark:text-sky-100",
    },
    source: {
      web: "border-emerald-500/30 dark:border-emerald-300/30 bg-emerald-500/20 dark:bg-emerald-500/15 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100",
      referral: "border-violet-500/30 dark:border-violet-300/30 bg-violet-500/20 dark:bg-violet-500/15 dark:bg-violet-500/10 text-violet-700 dark:text-violet-100",
      event: "border-amber-500/30 dark:border-amber-300/30 bg-amber-500/20 dark:bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-100",
      cold_call: "border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 text-rose-700 dark:text-rose-100",
      partner: "border-cyan-500/30 dark:border-cyan-300/30 bg-cyan-500/20 dark:bg-cyan-500/15 dark:bg-cyan-500/10 text-cyan-700 dark:text-cyan-100",
      marketing: "border-blue-500/30 dark:border-blue-300/30 bg-blue-500/20 dark:bg-blue-500/15 dark:bg-blue-500/10 text-blue-700 dark:text-blue-100",
      import: "border-border bg-muted/40 text-muted-foreground",
      other: "border-border bg-muted/40 text-muted-foreground",
    },
    provenance: {
      manual: "border-border bg-muted/40 text-muted-foreground",
      imported: "border-amber-500/30 dark:border-amber-300/30 bg-amber-500/20 dark:bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-100",
      api: "border-cyan-500/30 dark:border-cyan-300/30 bg-cyan-500/20 dark:bg-cyan-500/15 dark:bg-cyan-500/10 text-cyan-700 dark:text-cyan-100",
    },
  };
  const cls = palette[kind]?.[value] ?? "border-border bg-muted/40 text-muted-foreground/80";
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}

function FilterSelect({
  name,
  defaultValue,
  options,
  placeholder,
}: {
  name: string;
  defaultValue?: string;
  options: readonly string[];
  placeholder: string;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue ?? ""}
      className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
    >
      <option value="">All {placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o.replaceAll("_", " ")}
        </option>
      ))}
    </select>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  searchParams,
}: {
  page: number;
  pageSize: number;
  total: number;
  searchParams: SearchParams;
}) {
  const totalPages = Math.ceil(total / pageSize);
  const buildHref = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (typeof v === "string" && v.length > 0 && k !== "page") params.set(k, v);
    }
    params.set("page", String(p));
    return `/leads?${params.toString()}`;
  };
  return (
    <nav className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
      <span>
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={buildHref(page - 1)}
            className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
          >
            ← Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={buildHref(page + 1)}
            className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
          >
            Next →
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

// noop import marker to keep DEFAULT_COLUMNS reachable for any
// future server-side default-column resolver.
void DEFAULT_COLUMNS;
