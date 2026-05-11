import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
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
import { AddVisibleToListButton } from "./_components/add-visible-to-list-button";
import { BulkTagButton } from "./_components/bulk-tag-button";
import { SortableLeadsHeaders } from "./_components/sortable-leads-headers";
import { listTags } from "@/lib/tags";
import { MobileFilterSelect } from "./_components/filters-mobile";
import { LeadListMobile } from "./_components/lead-list-mobile";
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

  // Phase 25 §7.2 — active subscription state per saved view. The
  // toolbar uses this to render Subscribe vs Unsubscribe on the
  // current saved view. Cheap query — bounded by the user's own
  // saved-view count.
  const subscribedRows = await db
    .select({ savedViewId: savedSearchSubscriptions.savedViewId })
    .from(savedSearchSubscriptions)
    .where(
      and(
        eq(savedSearchSubscriptions.userId, user.id),
        eq(savedSearchSubscriptions.isActive, true),
      ),
    );
  const subscribedViewIds = subscribedRows.map((r) => r.savedViewId);

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
  // Phase 25 §7.5 — preload tags for the BulkTagButton picker.
  // Cheap query (tags table is small) and cached at the page level
  // so we don't fetch per-render of the dropdown.
  const allTags = await listTags();

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
    // Phase 12 Sub-E — responsive padding. 16px gutter on mobile up
    // through tablet, 40px on desktop ≥1280px.
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Leads" }]} />
      {/* Phase 12 — Supabase Realtime is the primary push channel; the
          Phase 11 polling layer remains as the documented fallback. */}
      <PageRealtime entities={["leads"]} />
      <PagePoll entities={["leads"]} />
      {/* Phase 12 Sub-E — header row stacks on mobile, returns to
          horizontal layout at >=640px so the +Add lead / Import /
          Export pills don't collide with the title block. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
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
        {/* Phase 12 — at <md only `+Add lead` shows. Pipeline / Import
            / Export / Table-Pipeline toggle are power-user controls
            that crowded a 380 px viewport; they reappear at md+. */}
        <div className="flex flex-wrap gap-2">
          <div className="hidden gap-1 rounded-lg border border-glass-border bg-glass-1 p-1 md:flex">
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
              className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted md:inline-flex"
            >
              Import
            </Link>
          ) : null}
          {perms.canExport || user.isAdmin ? (
            <a
              href={buildExportHref(sp)}
              className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted md:inline-flex"
            >
              Export
            </a>
          ) : null}
          {/* Phase 21 — bulk add visible leads to a marketing list. Gated
              upstream so the button only renders for admins / users with
              canManageMarketing. Desktop-only to match Import/Export. */}
          <div className="hidden md:inline-flex">
            <AddVisibleToListButton
              leadIds={result.rows.map((r) => r.id)}
              canManage={user.isAdmin || perms.canManageMarketing}
            />
          </div>
          {/* Phase 25 §7.5 — bulk-tag toolbar. Acts on the currently
              visible leadIds (same pattern as AddVisibleToList);
              backed by the existing bulkTagLeadsAction. */}
          <div className="hidden md:inline-flex">
            <BulkTagButton
              leadIds={result.rows.map((r) => r.id)}
              availableTags={allTags}
            />
          </div>
          {perms.canCreateLeads || user.isAdmin ? (
            <Link
              href="/leads/new"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              + Add lead
            </Link>
          ) : null}
        </div>
      </div>

      {/* ViewToolbar is desktop-only — view selector, MODIFIED badge,
          Save-as-new, Columns chooser are all power-user features
          that don't fit the mobile toolbar. */}
      <div className="mt-5 hidden md:block">
        <ViewToolbar
          views={allViews}
          activeViewId={activeViewParam}
          activeColumns={activeColumns}
          baseColumns={baseColumns}
          savedDirtyId={savedDirtyId}
          columnsModified={columnsModified}
          subscribedViewIds={subscribedViewIds}
        />
      </div>

      {/* Phase 12 — sticky at <md so search stays in view while
          scrolling. Two rows on mobile: a tall search bar with a
          leading magnifier, then a horizontal-scroll chip row of
          filters that auto-submit on change. md+ collapses to one
          row with an explicit Apply button. */}
      <form
        action="/leads"
        method="get"
        className="mt-5 sticky top-0 z-30 -mx-4 space-y-2 border-b border-border/40 bg-background/85 px-4 pb-3 pt-3 backdrop-blur-md sm:-mx-6 sm:px-6 md:static md:z-auto md:mx-0 md:space-y-0 md:border-0 md:bg-transparent md:px-0 md:pt-0 md:pb-0 md:backdrop-blur-none"
      >
        <input type="hidden" name="view" value={activeViewParam} />

        {/* ROW 1 — search. Tall on mobile (h-11) with a leading
            magnifier so it reads as a primary input, not a filter
            among many. md+ keeps it inline with the filters. */}
        <div className="md:hidden">
          <label className="relative block">
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
            >
              <circle cx={9} cy={9} r={6} />
              <path d="m17 17-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              name="q"
              type="search"
              defaultValue={sp.q ?? ""}
              placeholder="Search name, email, company…"
              className="block h-11 w-full rounded-full border border-border bg-muted/40 pl-10 pr-4 text-base text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </label>
        </div>

        {/* ROW 2 — filter chips at <md (auto-submit on change),
            inline with desktop search at md+. */}
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:gap-3 md:overflow-visible md:px-0 md:pb-0">
          {/* Desktop search — visible only at md+ to share the row. */}
          <input
            name="q"
            type="search"
            defaultValue={sp.q ?? ""}
            placeholder="Search name / email / company / phone…"
            className="hidden flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:block md:min-w-[240px]"
          />
          {/* Mobile chip-style auto-submitting selects (md:hidden). */}
          <div className="contents md:hidden">
            <MobileFilterSelect
              name="status"
              defaultValue={sp.status}
              options={LEAD_STATUSES}
              placeholder="Status"
            />
            <MobileFilterSelect
              name="rating"
              defaultValue={sp.rating}
              options={LEAD_RATINGS}
              placeholder="Rating"
            />
            <MobileFilterSelect
              name="source"
              defaultValue={sp.source}
              options={LEAD_SOURCES}
              placeholder="Source"
            />
            {sp.q || sp.status || sp.rating || sp.source || sp.tag ? (
              <Link
                href={`/leads?view=${encodeURIComponent(activeViewParam)}`}
                className="shrink-0 rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground/90"
              >
                Clear
              </Link>
            ) : null}
          </div>
          {/* Desktop selects + Apply (hidden on mobile). */}
          <div className="hidden items-center gap-2 md:flex md:gap-3">
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
          </div>
        </div>
      </form>

      {/* Phase 12 — dense single-line list at <768px (replaces the
          earlier `data-table-cards` reflow which produced ~200 px
          per row of stacked field labels — unusable at scale).
          Hidden at md+ where the desktop table takes over. */}
      <div className="mt-6 md:hidden">
        <LeadListMobile rows={result.rows} />
      </div>

      <div className="mt-6 hidden overflow-x-auto rounded-2xl border border-border bg-muted/40 backdrop-blur-xl md:block">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          {/* Phase 25 §7.5 — DnD column reorder via @dnd-kit/sortable.
              Drag a header horizontally to reorder; setAdhocColumnsAction
              persists, then revalidatePath re-renders the table body
              with the new column order applied to every row cell. */}
          <SortableLeadsHeaders
            initialColumns={activeColumns}
            activeViewId={activeViewParam}
          />
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
                {activeColumns.map((c) => {
                  const colLabel =
                    AVAILABLE_COLUMNS.find((col) => col.key === c)?.label ?? c;
                  return (
                    <td
                      key={c}
                      data-label={colLabel}
                      className="px-5 py-3 align-top"
                    >
                      {renderCell(l, c, timePrefs)}
                    </td>
                  );
                })}
                {/* Trailing actions cell deliberately has no
                    data-label; the card-mode CSS positions it in
                    the top-right corner of the stacked card. */}
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
      // Photo URL is projected via the leftJoin on users so the
      // avatar resolves without a per-row Graph fetch.
      return lead.ownerId ? (
        <UserChip
          user={{
            id: lead.ownerId,
            displayName: lead.ownerDisplayName,
            photoUrl: lead.ownerPhotoUrl,
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
  // Phase 12 (Sub-D) — palette uses semantic --status-*/--priority-* tokens
  // from globals.css so light/dark theme drift can't reintroduce raw
  // Tailwind palette literals. Borders share the foreground token at low
  // alpha so the pill outline reads against either surface.
  const palette: Record<string, Record<string, string>> = {
    status: {
      new: "border-[var(--status-new-fg)]/30 bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
      contacted:
        "border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
      qualified:
        "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
      unqualified:
        "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
      converted:
        "border-[var(--status-proposal-fg)]/30 bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
      lost: "border-border bg-muted/40 text-muted-foreground/80",
    },
    rating: {
      hot: "border-[var(--priority-very-high-fg)]/30 bg-[var(--priority-very-high-bg)] text-[var(--priority-very-high-fg)]",
      warm: "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
      cold: "border-[var(--priority-very-low-fg)]/30 bg-[var(--priority-very-low-bg)] text-[var(--priority-very-low-fg)]",
    },
    source: {
      web: "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]",
      referral:
        "border-[var(--status-proposal-fg)]/30 bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]",
      event:
        "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
      cold_call:
        "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]",
      partner:
        "border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
      marketing:
        "border-[var(--status-new-fg)]/30 bg-[var(--status-new-bg)] text-[var(--status-new-fg)]",
      import: "border-border bg-muted/40 text-muted-foreground",
      other: "border-border bg-muted/40 text-muted-foreground",
    },
    provenance: {
      manual: "border-border bg-muted/40 text-muted-foreground",
      imported:
        "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]",
      api: "border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] text-[var(--status-contacted-fg)]",
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
