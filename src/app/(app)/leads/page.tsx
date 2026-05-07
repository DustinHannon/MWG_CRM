import Link from "next/link";
import { redirect } from "next/navigation";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
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
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllRecords;

  // ---- Resolve active view -----------------------------------------------
  // 1. ?view= explicit. 2. last_used_view_id from prefs. 3. fallback to my-open.
  const prefs = await getPreferences(user.id);
  let activeViewParam = sp.view;
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
  const result = await runView({
    view: activeView,
    user,
    canViewAll,
    page,
    pageSize,
    columns: activeColumns,
    sort,
    extraFilters,
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
    })),
  ];

  const columnsModified =
    activeColumns.length !== baseColumns.length ||
    activeColumns.some((c, i) => baseColumns[i] !== c);

  const savedDirtyId = activeView.source === "saved" ? activeView.id : null;

  return (
    <div className="px-10 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {result.total} {result.total === 1 ? "lead" : "leads"}
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
              className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
            >
              Import
            </Link>
          ) : null}
          {perms.canExport || user.isAdmin ? (
            <a
              href={buildExportHref(sp)}
              className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
            >
              Export
            </a>
          ) : null}
          {perms.canCreateLeads || user.isAdmin ? (
            <Link
              href="/leads/new"
              className="rounded-md bg-white/90 px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-white"
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
          className="min-w-[240px] flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
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
          className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
        >
          Apply
        </button>
        {sp.q || sp.status || sp.rating || sp.source || sp.tag ? (
          <Link
            href={`/leads?view=${encodeURIComponent(activeViewParam)}`}
            className="rounded-md px-3 py-2 text-sm text-white/50 hover:text-white/80"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10 bg-white/5 backdrop-blur-xl">
        <table className="min-w-full divide-y divide-white/5 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-white/50">
              {activeColumns.map((c) => (
                <th key={c} className="px-5 py-3 font-medium whitespace-nowrap">
                  {AVAILABLE_COLUMNS.find((col) => col.key === c)?.label ?? c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {result.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={activeColumns.length}
                  className="px-5 py-12 text-center text-white/50"
                >
                  No leads match this view.
                </td>
              </tr>
            ) : null}
            {result.rows.map((l) => (
              <tr key={l.id} className="transition hover:bg-white/5">
                {activeColumns.map((c) => (
                  <td key={c} className="px-5 py-3 align-top">
                    {renderCell(l, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.total > pageSize ? (
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

function buildExportHref(sp: SearchParams): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && v.length > 0) params.set(k, v);
  }
  return `/api/leads/export?${params.toString()}`;
}

function renderCell(lead: LeadRow, col: ColumnKey) {
  switch (col) {
    case "firstName":
      return (
        <Link
          href={`/leads/${lead.id}`}
          className="font-medium text-white hover:underline"
        >
          {lead.firstName}
        </Link>
      );
    case "lastName":
      return (
        <Link
          href={`/leads/${lead.id}`}
          className="font-medium text-white hover:underline"
        >
          {lead.lastName}
        </Link>
      );
    case "companyName":
      return <span className="text-white/70">{lead.companyName ?? "—"}</span>;
    case "email":
      return <span className="text-white/60">{lead.email ?? "—"}</span>;
    case "phone":
      return <span className="text-white/60">{lead.phone ?? "—"}</span>;
    case "mobilePhone":
      return <span className="text-white/60">{lead.mobilePhone ?? "—"}</span>;
    case "jobTitle":
      return <span className="text-white/60">{lead.jobTitle ?? "—"}</span>;
    case "status":
      return <Pill kind="status" value={lead.status} />;
    case "rating":
      return <Pill kind="rating" value={lead.rating} />;
    case "source":
      return <Pill kind="source" value={lead.source} />;
    case "owner":
      return (
        <span className="text-white/60">
          {lead.ownerDisplayName ?? "Unassigned"}
        </span>
      );
    case "tags":
      return (
        <span className="text-xs text-white/60">
          {lead.tags?.length ? lead.tags.join(", ") : "—"}
        </span>
      );
    case "city":
      return <span className="text-white/60">{lead.city ?? "—"}</span>;
    case "state":
      return <span className="text-white/60">{lead.state ?? "—"}</span>;
    case "estimatedValue":
      return (
        <span className="tabular-nums text-white/60">
          {lead.estimatedValue ? `$${Number(lead.estimatedValue).toLocaleString()}` : "—"}
        </span>
      );
    case "estimatedCloseDate":
      return (
        <span className="text-white/60">
          {lead.estimatedCloseDate ?? "—"}
        </span>
      );
    case "createdBy":
      return (
        <span className="text-white/60">
          {lead.createdByDisplayName ?? "—"}
        </span>
      );
    case "createdVia":
      return <Pill kind="provenance" value={lead.createdVia} />;
    case "createdAt":
      return (
        <span className="text-white/50">
          {new Date(lead.createdAt).toLocaleDateString()}
        </span>
      );
    case "lastActivityAt":
      return (
        <span className="text-white/50">
          {lead.lastActivityAt
            ? new Date(lead.lastActivityAt).toLocaleString()
            : "—"}
        </span>
      );
    case "updatedAt":
      return (
        <span className="text-white/50">
          {new Date(lead.updatedAt).toLocaleString()}
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
      new: "border-blue-300/30 bg-blue-500/10 text-blue-100",
      contacted: "border-cyan-300/30 bg-cyan-500/10 text-cyan-100",
      qualified: "border-emerald-300/30 bg-emerald-500/10 text-emerald-100",
      unqualified: "border-rose-300/30 bg-rose-500/10 text-rose-100",
      converted: "border-violet-300/30 bg-violet-500/10 text-violet-100",
      lost: "border-white/15 bg-white/5 text-white/40",
    },
    rating: {
      hot: "border-rose-300/30 bg-rose-500/10 text-rose-100",
      warm: "border-amber-300/30 bg-amber-500/10 text-amber-100",
      cold: "border-sky-300/30 bg-sky-500/10 text-sky-100",
    },
    source: {
      web: "border-emerald-300/30 bg-emerald-500/10 text-emerald-100",
      referral: "border-violet-300/30 bg-violet-500/10 text-violet-100",
      event: "border-amber-300/30 bg-amber-500/10 text-amber-100",
      cold_call: "border-rose-300/30 bg-rose-500/10 text-rose-100",
      partner: "border-cyan-300/30 bg-cyan-500/10 text-cyan-100",
      marketing: "border-blue-300/30 bg-blue-500/10 text-blue-100",
      import: "border-white/15 bg-white/5 text-white/60",
      other: "border-white/15 bg-white/5 text-white/60",
    },
    provenance: {
      manual: "border-white/15 bg-white/5 text-white/60",
      imported: "border-amber-300/30 bg-amber-500/10 text-amber-100",
      api: "border-cyan-300/30 bg-cyan-500/10 text-cyan-100",
    },
  };
  const cls = palette[kind]?.[value] ?? "border-white/15 bg-white/5 text-white/40";
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
      className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
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
    <nav className="mt-6 flex items-center justify-between text-sm text-white/60">
      <span>
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={buildHref(page - 1)}
            className="rounded-md border border-white/15 px-3 py-1.5 hover:bg-white/5"
          >
            ← Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={buildHref(page + 1)}
            className="rounded-md border border-white/15 px-3 py-1.5 hover:bg-white/5"
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
