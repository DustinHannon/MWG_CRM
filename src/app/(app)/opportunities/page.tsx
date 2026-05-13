import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { StandardPageHeader } from "@/components/standard";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { UserChip } from "@/components/user-display";
import { StatusPill } from "@/components/ui/status-pill";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { canDeleteOpportunity } from "@/lib/access/can-delete";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";
import { listTags } from "@/lib/tags";
import { BulkTagButton } from "@/components/tags/bulk-tag-button";
import { TagFilterSelect } from "@/components/tags/tag-filter-select";
import { TagsCell } from "@/components/tags/tags-cell";
import { OpportunityListMobile } from "./_components/opportunity-list-mobile";
import { OpportunityRowActions } from "./_components/opportunity-row-actions";
import { MobileOpportunityFilterSelect } from "./_components/filters-mobile";
import { SortableOpportunitiesHeaders } from "./_components/sortable-headers";
import {
  BulkArchiveBar,
  BulkArchiveProvider,
  RowCheckbox,
} from "./_components/bulk-archive";
import {
  OpportunityViewToolbar,
  type OpportunityViewSummary,
} from "./view-toolbar";
import {
  AVAILABLE_OPPORTUNITY_COLUMNS,
  OPPORTUNITY_COLUMN_KEYS,
  type OpportunityColumnKey,
  type OpportunitySortField,
} from "@/lib/opportunity-view-constants";
import {
  findBuiltinOpportunityView,
  getOpportunityPreferences,
  getSavedOpportunityView,
  listOpportunityAccountPicker,
  listSavedOpportunityViewsForUser,
  runOpportunityView,
  visibleOpportunityBuiltins,
  type OpportunityRow,
  type OpportunityViewDefinition,
} from "@/lib/opportunity-views";

export const dynamic = "force-dynamic";

interface SearchParams {
  view?: string;
  q?: string;
  owner?: string;
  account?: string;
  stage?: string;
  closingWithinDays?: string;
  minAmount?: string;
  maxAmount?: string;
  tag?: string;
  page?: string;
  cols?: string;
  sort?: string;
  dir?: string;
  cursor?: string;
}

const STAGE_LABELS: Record<string, string> = {
  prospecting: "Prospecting",
  qualification: "Qualification",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed-won",
  closed_lost: "Closed-lost",
};

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllRecords;

  // ---- Resolve active view -----------------------------------------------
  // precedence:
  // 1. ?view= explicit
  // 2. user_preferences.default_opportunity_view_id
  // 3. fallback to builtin:my-open
  const prefs = await getOpportunityPreferences(user.id);
  let activeViewParam = sp.view;
  if (!activeViewParam && prefs.defaultOpportunityViewId) {
    activeViewParam = `saved:${prefs.defaultOpportunityViewId}`;
  }
  if (!activeViewParam) activeViewParam = "builtin:my-open";

  const savedViews = await listSavedOpportunityViewsForUser(user.id);

  // active subscription state per saved view.
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

  let activeView: OpportunityViewDefinition | null = null;
  if (activeViewParam.startsWith("saved:")) {
    const id = activeViewParam.slice("saved:".length);
    activeView = await getSavedOpportunityView(user.id, id);
    if (!activeView) {
      redirect("/opportunities?view=builtin:my-open");
    }
  } else {
    activeView = findBuiltinOpportunityView(activeViewParam);
    if (activeView?.requiresAllOpportunities && !canViewAll) {
      activeView = findBuiltinOpportunityView("builtin:my-open");
    }
    if (!activeView)
      activeView = findBuiltinOpportunityView("builtin:my-open");
  }
  if (!activeView) {
    redirect("/opportunities?view=builtin:my-open");
  }

  // ---- URL filter overlay ------------------------------------------------
  const extraFilters = {
    search: sp.q || undefined,
    owner: sp.owner ? sp.owner.split(",").filter(Boolean) : undefined,
    account: sp.account ? sp.account.split(",").filter(Boolean) : undefined,
    stage: sp.stage
      ? sp.stage.split(",").filter(Boolean)
      : undefined,
    closingWithinDays: sp.closingWithinDays
      ? Number(sp.closingWithinDays) || undefined
      : undefined,
    minAmount: sp.minAmount
      ? Number.isFinite(Number(sp.minAmount))
        ? Number(sp.minAmount)
        : undefined
      : undefined,
    maxAmount: sp.maxAmount
      ? Number.isFinite(Number(sp.maxAmount))
        ? Number(sp.maxAmount)
        : undefined
      : undefined,
    tags: sp.tag
      ? sp.tag
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined,
  };

  // ---- Resolve column list -----------------------------------------------
  const baseColumns = activeView.columns;
  const urlCols = sp.cols
    ? (sp.cols
        .split(",")
        .filter((c): c is OpportunityColumnKey =>
          OPPORTUNITY_COLUMN_KEYS.includes(c as OpportunityColumnKey),
        ) as OpportunityColumnKey[])
    : null;
  let activeColumns: OpportunityColumnKey[];
  if (urlCols && urlCols.length > 0) {
    activeColumns = urlCols;
  } else if (activeView.source === "builtin" && prefs.adhocColumns?.length) {
    activeColumns = prefs.adhocColumns;
  } else {
    activeColumns = baseColumns;
  }

  // ---- Page / sort -------------------------------------------------------
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const pageSize = 50;
  const sort = sp.sort
    ? {
        field: (sp.sort as OpportunitySortField) ?? "expectedCloseDate",
        direction: (sp.dir === "asc" ? "asc" : "desc") as "asc" | "desc",
      }
    : undefined;

  // ---- Run the query -----------------------------------------------------
  const result = await runOpportunityView({
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
  const accountPickerRows = await listOpportunityAccountPicker({
    userId: user.id,
    canViewAll,
  });
  // preload the tags catalogue for the filter dropdown + bulk-tag picker.
  const allTags = await listTags();
  const ownerPickerRows = canViewAll
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(eq(users.isActive, true))
        .orderBy(asc(users.displayName))
        .limit(200)
    : [];

  const allViews: OpportunityViewSummary[] = [
    ...visibleOpportunityBuiltins(canViewAll).map((v) => ({
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

  const viewModified =
    columnsModified ||
    Boolean(sp.q) ||
    Boolean(sp.owner) ||
    Boolean(sp.account) ||
    Boolean(sp.stage) ||
    Boolean(sp.closingWithinDays) ||
    Boolean(sp.minAmount) ||
    Boolean(sp.maxAmount) ||
    Boolean(sp.tag) ||
    Boolean(sp.sort) ||
    Boolean(sp.dir);

  const modifiedFields: string[] = [];
  if (columnsModified) modifiedFields.push("columns");
  if (sp.q) modifiedFields.push("search");
  if (
    sp.owner ||
    sp.account ||
    sp.stage ||
    sp.closingWithinDays ||
    sp.minAmount ||
    sp.maxAmount ||
    sp.tag
  ) {
    modifiedFields.push("filters");
  }
  if (sp.sort || sp.dir) modifiedFields.push("sort");

  const savedDirtyId = activeView.source === "saved" ? activeView.id : null;
  const defaultViewIdFull = prefs.defaultOpportunityViewId
    ? `saved:${prefs.defaultOpportunityViewId}`
    : null;

  const accountOptions = accountPickerRows.map((a) => ({
    value: a.id,
    label: a.name,
  }));
  const ownerOptions = ownerPickerRows.map((o) => ({
    value: o.id,
    label: o.displayName,
  }));
  const stageOptions = OPPORTUNITY_STAGES.map((s) => ({
    value: s,
    label: STAGE_LABELS[s] ?? s,
  }));
  const closingWithinOptions = [
    { value: "7", label: "Closing in 7 days" },
    { value: "30", label: "Closing in 30 days" },
    { value: "90", label: "Closing in 90 days" },
  ];

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Opportunities" }]} />
      <PageRealtime entities={["opportunities"]} />
      <PagePoll entities={["opportunities"]} />
      <StandardPageHeader
        kicker="Opportunities"
        title="Opportunities"
        fontFamily="display"
        description={
          <>
            {result.total > 0
              ? `${result.total} ${result.total === 1 ? "opportunity" : "opportunities"}`
              : `${result.rows.length}${result.nextCursor ? "+" : ""} ${result.rows.length === 1 ? "opportunity" : "opportunities"}`}
            {sp.q ? ` matching "${sp.q}"` : ""} · view {activeView.name}
          </>
        }
        controls={
          // Table↔Pipeline toggle preserved from prior page. The Table
          // pill stays inert/active here; Pipeline is a link to the
          // kanban view at /opportunities/pipeline.
          <div className="hidden gap-1 rounded-lg border border-glass-border bg-glass-1 p-1 md:flex">
            <span className="rounded bg-primary/20 px-3 py-1.5 text-xs font-medium text-foreground">
              Table
            </span>
            <Link
              href="/opportunities/pipeline"
              className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Pipeline
            </Link>
          </div>
        }
        actions={
          <>
            {user.isAdmin ? (
              <Link
                href="/opportunities/archived"
                className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 transition hover:bg-muted md:inline-flex"
              >
                Archived
              </Link>
            ) : null}
            {/* bulk-tag toolbar. Acts on the currently
                visible recordIds; backed by bulkTagAction. */}
            <div className="hidden md:inline-flex">
              <BulkTagButton
                entityType="opportunity"
                recordIds={result.rows.map((r) => r.id)}
                availableTags={allTags}
              />
            </div>
            <Link
              href="/opportunities/new"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              + New opportunity
            </Link>
          </>
        }
      />

      <BulkArchiveProvider>
        {/* Desktop toolbar — view selector + Modified badge + columns. */}
        <div className="mt-5 hidden md:block">
          <OpportunityViewToolbar
            views={allViews}
            activeViewId={activeViewParam}
            activeViewName={activeView.name}
            activeColumns={activeColumns}
            baseColumns={baseColumns}
            savedDirtyId={savedDirtyId}
            columnsModified={columnsModified}
            viewModified={viewModified}
            modifiedFields={modifiedFields}
            subscribedViewIds={subscribedViewIds}
            defaultViewId={defaultViewIdFull}
          />
        </div>

        {/* Selection bar (renders when ≥1 row checked). */}
        <div className="mt-3 hidden md:block">
          <BulkArchiveBar />
        </div>

        {/* Filter form. */}
        <form
          action="/opportunities"
          method="get"
          className="mt-5 sticky top-0 z-30 -mx-4 space-y-2 border-b border-border/40 bg-background/85 px-4 pb-3 pt-3 backdrop-blur-md sm:-mx-6 sm:px-6 md:static md:z-auto md:mx-0 md:space-y-0 md:border-0 md:bg-transparent md:px-0 md:pt-0 md:pb-0 md:backdrop-blur-none"
        >
          <input type="hidden" name="view" value={activeViewParam} />

          {/* Mobile search row. */}
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
                placeholder="Search name or description…"
                className="block h-11 w-full rounded-full border border-border bg-muted/40 pl-10 pr-4 text-base text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </label>
          </div>

          {/* Filter chips row. */}
          <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:gap-3 md:overflow-visible md:px-0 md:pb-0">
            <input
              name="q"
              type="search"
              defaultValue={sp.q ?? ""}
              placeholder="Search name or description…"
              className="hidden flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:block md:min-w-[240px]"
            />
            <div className="contents md:hidden">
              <MobileOpportunityFilterSelect
                name="stage"
                defaultValue={sp.stage}
                options={stageOptions}
                placeholder="Stage"
              />
              {accountOptions.length > 0 ? (
                <MobileOpportunityFilterSelect
                  name="account"
                  defaultValue={sp.account}
                  options={accountOptions}
                  placeholder="Account"
                />
              ) : null}
              {ownerOptions.length > 0 ? (
                <MobileOpportunityFilterSelect
                  name="owner"
                  defaultValue={sp.owner}
                  options={ownerOptions}
                  placeholder="Owner"
                />
              ) : null}
              <MobileOpportunityFilterSelect
                name="closingWithinDays"
                defaultValue={sp.closingWithinDays}
                options={closingWithinOptions}
                placeholder="Closing"
              />
              {sp.q ||
              sp.owner ||
              sp.account ||
              sp.stage ||
              sp.closingWithinDays ||
              sp.minAmount ||
              sp.maxAmount ? (
                <Link
                  href={`/opportunities?view=${encodeURIComponent(activeViewParam)}`}
                  className="shrink-0 rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground/90"
                >
                  Clear
                </Link>
              ) : null}
            </div>
            <div className="hidden items-center gap-2 md:flex md:gap-3">
              <FilterSelect
                name="stage"
                defaultValue={sp.stage}
                options={stageOptions}
                placeholder="Stage"
              />
              {accountOptions.length > 0 ? (
                <FilterSelect
                  name="account"
                  defaultValue={sp.account}
                  options={accountOptions}
                  placeholder="Account"
                />
              ) : null}
              {ownerOptions.length > 0 ? (
                <FilterSelect
                  name="owner"
                  defaultValue={sp.owner}
                  options={ownerOptions}
                  placeholder="Owner"
                />
              ) : null}
              <FilterSelect
                name="closingWithinDays"
                defaultValue={sp.closingWithinDays}
                options={closingWithinOptions}
                placeholder="Closing"
              />
              <input
                name="minAmount"
                type="number"
                min="0"
                step="100"
                defaultValue={sp.minAmount ?? ""}
                placeholder="Min $"
                className="w-24 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <input
                name="maxAmount"
                type="number"
                min="0"
                step="100"
                defaultValue={sp.maxAmount ?? ""}
                placeholder="Max $"
                className="w-24 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              <TagFilterSelect
                name="tag"
                options={allTags.map((t) => ({
                  id: t.id,
                  name: t.name,
                  color: t.color,
                }))}
                defaultValue={sp.tag}
                placeholder="Tags"
              />
              <button
                type="submit"
                className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
              >
                Apply
              </button>
              {sp.q ||
              sp.owner ||
              sp.account ||
              sp.stage ||
              sp.closingWithinDays ||
              sp.minAmount ||
              sp.maxAmount ||
              sp.tag ? (
                <Link
                  href={`/opportunities?view=${encodeURIComponent(activeViewParam)}`}
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground/90"
                >
                  Clear
                </Link>
              ) : null}
            </div>
          </div>
        </form>

        {/* Mobile list. */}
        <div className="mt-6 md:hidden">
          <OpportunityListMobile
            rows={result.rows.map((r) => ({
              id: r.id,
              name: r.name,
              stage: r.stage,
              amount: r.amount ?? null,
              accountName: r.accountName ?? null,
              expectedCloseDate: r.expectedCloseDate ?? null,
            }))}
            emptyMessage={
              <>
                No opportunities match this view.{" "}
                <Link
                  href="/opportunities/new"
                  className="underline hover:text-foreground"
                >
                  Add the first one
                </Link>{" "}
                or convert a lead.
              </>
            }
          />
        </div>

        {/* Desktop table. */}
        <GlassCard className="mt-6 hidden overflow-hidden p-0 md:block">
          {result.rows.length === 0 ? (
            <p className="p-12 text-center text-sm text-muted-foreground">
              No opportunities match this view.{" "}
              <Link
                href="/opportunities/new"
                className="underline hover:text-foreground"
              >
                Add the first one
              </Link>{" "}
              or convert a lead.
            </p>
          ) : (
            <table className="data-table w-full text-sm">
              <SortableOpportunitiesHeaders
                initialColumns={activeColumns}
                activeViewId={activeViewParam}
              />
              <tbody className="divide-y divide-glass-border">
                {result.rows.map((r) => (
                  <tr key={r.id} className="group transition hover:bg-muted/40">
                    <td className="w-10 px-2 py-2.5 align-middle">
                      <RowCheckbox id={r.id} />
                    </td>
                    {activeColumns.map((c) => {
                      const colLabel =
                        AVAILABLE_OPPORTUNITY_COLUMNS.find(
                          (col) => col.key === c,
                        )?.label ?? c;
                      return (
                        <td
                          key={c}
                          data-label={colLabel}
                          className="px-5 py-2.5 align-top"
                        >
                          {renderCell(r, c)}
                        </td>
                      );
                    })}
                    <td className="w-10 px-2 py-2.5 align-middle">
                      <OpportunityRowActions
                        opportunityId={r.id}
                        opportunityName={r.name}
                        canDelete={canDeleteOpportunity(user, {
                          ownerId: r.ownerId,
                        })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </GlassCard>

        {result.nextCursor || sp.cursor ? (
          <CursorNav nextCursor={result.nextCursor} sp={sp} />
        ) : result.total > pageSize ? (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            searchParams={sp}
          />
        ) : null}
      </BulkArchiveProvider>
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
    return `/opportunities?${params.toString()}`;
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

function formatAmount(a: string | null): string {
  if (a === null || a === undefined || a === "") return "—";
  const n = Number(a);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function formatExpectedCloseDate(d: string | null): React.ReactNode {
  if (!d) return <span className="text-muted-foreground/80">—</span>;
  // d is a yyyy-mm-dd string from the date column; render as MM/DD/YYYY.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return <span className="text-muted-foreground">{d}</span>;
  return (
    <span className="text-muted-foreground tabular-nums">
      {m[2]}/{m[3]}/{m[1]}
    </span>
  );
}

function renderCell(row: OpportunityRow, col: OpportunityColumnKey) {
  switch (col) {
    case "name":
      return (
        <Link
          href={`/opportunities/${row.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {row.name}
        </Link>
      );
    case "stage":
      return <StatusPill status={row.stage} />;
    case "account":
      return row.accountId ? (
        <Link
          href={`/accounts/${row.accountId}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.accountName ?? "—"}
        </Link>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "primaryContact":
      return row.primaryContactId ? (
        <Link
          href={`/contacts/${row.primaryContactId}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.primaryContactName ?? "—"}
        </Link>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "amount":
      return (
        <span className="tabular-nums text-foreground/80">
          {formatAmount(row.amount)}
        </span>
      );
    case "probability":
      return (
        <span className="tabular-nums text-muted-foreground">
          {typeof row.probability === "number" ? `${row.probability}%` : "—"}
        </span>
      );
    case "expectedCloseDate":
      return formatExpectedCloseDate(row.expectedCloseDate);
    case "owner":
      return row.ownerId ? (
        <UserChip
          user={{
            id: row.ownerId,
            displayName: row.ownerDisplayName,
            photoUrl: row.ownerPhotoUrl,
          }}
        />
      ) : (
        <span className="text-muted-foreground">Unassigned</span>
      );
    case "closedAt":
      return row.closedAt ? (
        <span className="text-muted-foreground">
          <UserTime value={row.closedAt} mode="date" />
        </span>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "tags":
      return <TagsCell tags={row.tags} />;
    case "createdAt":
      return (
        <span className="text-muted-foreground">
          <UserTime value={row.createdAt} mode="date" />
        </span>
      );
    case "updatedAt":
      return (
        <span className="text-muted-foreground">
          <UserTime value={row.updatedAt} />
        </span>
      );
    default:
      return null;
  }
}

function FilterSelect({
  name,
  defaultValue,
  options,
  placeholder,
}: {
  name: string;
  defaultValue?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
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
        <option key={o.value} value={o.value}>
          {o.label}
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
      if (typeof v === "string" && v.length > 0 && k !== "page") {
        params.set(k, v);
      }
    }
    params.set("page", String(p));
    return `/opportunities?${params.toString()}`;
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
