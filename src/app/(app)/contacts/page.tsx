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
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { canDeleteContact } from "@/lib/access/can-delete";
import { formatPersonName } from "@/lib/format/person-name";
import { ContactListMobile } from "./_components/contact-list-mobile";
import { ContactRowActions } from "./_components/contact-row-actions";
import {
  MobileContactBooleanChip,
  MobileContactFilterSelect,
} from "./_components/filters-mobile";
import { SortableContactsHeaders } from "./_components/sortable-headers";
import {
  BulkArchiveBar,
  BulkArchiveProvider,
  RowCheckbox,
} from "./_components/bulk-archive";
import {
  ContactViewToolbar,
  type ContactViewSummary,
} from "./view-toolbar";
import {
  AVAILABLE_CONTACT_COLUMNS,
  CONTACT_COLUMN_KEYS,
  type ContactColumnKey,
  type ContactSortField,
} from "@/lib/contact-view-constants";
import {
  findBuiltinContactView,
  getContactPreferences,
  getSavedContactView,
  listContactAccountPicks,
  listSavedContactViewsForUser,
  runContactView,
  visibleContactBuiltins,
  type ContactRow,
  type ContactViewDefinition,
} from "@/lib/contact-views";

export const dynamic = "force-dynamic";

interface SearchParams {
  view?: string;
  q?: string;
  owner?: string;
  account?: string;
  doNotContact?: string;
  doNotEmail?: string;
  doNotCall?: string;
  recentlyUpdatedDays?: string;
  page?: string;
  cols?: string;
  sort?: string;
  dir?: string;
  cursor?: string;
}

export default async function ContactsPage({
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
  // 2. user_preferences.default_contact_view_id
  // 3. fallback to builtin:my-open
  const prefs = await getContactPreferences(user.id);
  let activeViewParam = sp.view;
  if (!activeViewParam && prefs.defaultContactViewId) {
    activeViewParam = `saved:${prefs.defaultContactViewId}`;
  }
  if (!activeViewParam) activeViewParam = "builtin:my-open";

  const savedViews = await listSavedContactViewsForUser(user.id);

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

  let activeView: ContactViewDefinition | null = null;
  if (activeViewParam.startsWith("saved:")) {
    const id = activeViewParam.slice("saved:".length);
    activeView = await getSavedContactView(user.id, id);
    if (!activeView) {
      redirect("/contacts?view=builtin:my-open");
    }
  } else {
    activeView = findBuiltinContactView(activeViewParam);
    if (activeView?.requiresAllContacts && !canViewAll) {
      activeView = findBuiltinContactView("builtin:my-open");
    }
    if (!activeView) activeView = findBuiltinContactView("builtin:my-open");
  }
  if (!activeView) {
    redirect("/contacts?view=builtin:my-open");
  }

  // ---- URL filter overlay ------------------------------------------------
  const extraFilters = {
    search: sp.q || undefined,
    owner: sp.owner ? sp.owner.split(",").filter(Boolean) : undefined,
    account: sp.account ? sp.account.split(",").filter(Boolean) : undefined,
    doNotContact: sp.doNotContact === "1" ? true : undefined,
    doNotEmail: sp.doNotEmail === "1" ? true : undefined,
    doNotCall: sp.doNotCall === "1" ? true : undefined,
    recentlyUpdatedDays: sp.recentlyUpdatedDays
      ? Number(sp.recentlyUpdatedDays) || undefined
      : undefined,
  };

  // ---- Resolve column list -----------------------------------------------
  const baseColumns = activeView.columns;
  const urlCols = sp.cols
    ? (sp.cols
        .split(",")
        .filter((c): c is ContactColumnKey =>
          CONTACT_COLUMN_KEYS.includes(c as ContactColumnKey),
        ) as ContactColumnKey[])
    : null;
  let activeColumns: ContactColumnKey[];
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
        field: (sp.sort as ContactSortField) ?? "updatedAt",
        direction: (sp.dir === "asc" ? "asc" : "desc") as "asc" | "desc",
      }
    : undefined;

  // ---- Run the query -----------------------------------------------------
  const result = await runContactView({
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
  const accountPicks = await listContactAccountPicks({
    userId: user.id,
    canViewAll,
  });
  const ownerPickerRows = canViewAll
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(eq(users.isActive, true))
        .orderBy(asc(users.displayName))
        .limit(200)
    : [];

  const allViews: ContactViewSummary[] = [
    ...visibleContactBuiltins(canViewAll).map((v) => ({
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
    Boolean(sp.doNotContact) ||
    Boolean(sp.doNotEmail) ||
    Boolean(sp.doNotCall) ||
    Boolean(sp.recentlyUpdatedDays) ||
    Boolean(sp.sort) ||
    Boolean(sp.dir);

  const modifiedFields: string[] = [];
  if (columnsModified) modifiedFields.push("columns");
  if (sp.q) modifiedFields.push("search");
  if (
    sp.owner ||
    sp.account ||
    sp.doNotContact ||
    sp.doNotEmail ||
    sp.doNotCall ||
    sp.recentlyUpdatedDays
  ) {
    modifiedFields.push("filters");
  }
  if (sp.sort || sp.dir) modifiedFields.push("sort");

  const savedDirtyId = activeView.source === "saved" ? activeView.id : null;
  const defaultViewIdFull = prefs.defaultContactViewId
    ? `saved:${prefs.defaultContactViewId}`
    : null;

  const accountOptions = accountPicks.map((a) => ({
    value: a.id,
    label: a.name,
  }));
  const ownerOptions = ownerPickerRows.map((o) => ({
    value: o.id,
    label: o.displayName,
  }));
  const recentlyUpdatedOptions = [
    { value: "7", label: "Past 7 days" },
    { value: "30", label: "Past 30 days" },
    { value: "90", label: "Past 90 days" },
  ];

  const anyFilterApplied =
    sp.q ||
    sp.owner ||
    sp.account ||
    sp.doNotContact ||
    sp.doNotEmail ||
    sp.doNotCall ||
    sp.recentlyUpdatedDays;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Contacts" }]} />
      <PageRealtime entities={["contacts"]} />
      <PagePoll entities={["contacts"]} />
      <StandardPageHeader
        kicker="Contacts"
        title="Contacts"
        fontFamily="display"
        description={
          <>
            {result.total > 0
              ? `${result.total} ${result.total === 1 ? "contact" : "contacts"}`
              : `${result.rows.length}${result.nextCursor ? "+" : ""} ${result.rows.length === 1 ? "contact" : "contacts"}`}
            {sp.q ? ` matching "${sp.q}"` : ""} · view {activeView.name}
          </>
        }
        actions={
          <>
            {user.isAdmin ? (
              <Link
                href="/contacts/archived"
                className="hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/80 transition hover:bg-muted md:inline-flex"
              >
                Archived
              </Link>
            ) : null}
            <Link
              href="/contacts/new"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              + Add contact
            </Link>
          </>
        }
      />

      <BulkArchiveProvider>
        {/* Desktop toolbar — view selector + Modified badge + columns. */}
        <div className="mt-5 hidden md:block">
          <ContactViewToolbar
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
          action="/contacts"
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
                placeholder="Search name, email, title…"
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
              placeholder="Search name / email / title…"
              className="hidden flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 md:block md:min-w-[240px]"
            />
            <div className="contents md:hidden">
              {accountOptions.length > 0 ? (
                <MobileContactFilterSelect
                  name="account"
                  defaultValue={sp.account}
                  options={accountOptions}
                  placeholder="Account"
                />
              ) : null}
              {ownerOptions.length > 0 ? (
                <MobileContactFilterSelect
                  name="owner"
                  defaultValue={sp.owner}
                  options={ownerOptions}
                  placeholder="Owner"
                />
              ) : null}
              <MobileContactFilterSelect
                name="recentlyUpdatedDays"
                defaultValue={sp.recentlyUpdatedDays}
                options={recentlyUpdatedOptions}
                placeholder="Updated"
              />
              <MobileContactBooleanChip
                name="doNotContact"
                defaultChecked={sp.doNotContact === "1"}
                label="DNC"
              />
              <MobileContactBooleanChip
                name="doNotEmail"
                defaultChecked={sp.doNotEmail === "1"}
                label="No email"
              />
              <MobileContactBooleanChip
                name="doNotCall"
                defaultChecked={sp.doNotCall === "1"}
                label="No call"
              />
              {anyFilterApplied ? (
                <Link
                  href={`/contacts?view=${encodeURIComponent(activeViewParam)}`}
                  className="shrink-0 rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground/90"
                >
                  Clear
                </Link>
              ) : null}
            </div>
            <div className="hidden items-center gap-2 md:flex md:gap-3">
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
                name="recentlyUpdatedDays"
                defaultValue={sp.recentlyUpdatedDays}
                options={recentlyUpdatedOptions}
                placeholder="Updated"
              />
              <BooleanFilterChip
                name="doNotContact"
                defaultChecked={sp.doNotContact === "1"}
                label="DNC"
              />
              <BooleanFilterChip
                name="doNotEmail"
                defaultChecked={sp.doNotEmail === "1"}
                label="No email"
              />
              <BooleanFilterChip
                name="doNotCall"
                defaultChecked={sp.doNotCall === "1"}
                label="No call"
              />
              <button
                type="submit"
                className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
              >
                Apply
              </button>
              {anyFilterApplied ? (
                <Link
                  href={`/contacts?view=${encodeURIComponent(activeViewParam)}`}
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
          <ContactListMobile
            rows={result.rows.map((r) => ({
              id: r.id,
              firstName: r.firstName,
              lastName: r.lastName,
              jobTitle: r.jobTitle,
              email: r.email,
              accountName: r.accountName,
            }))}
            emptyMessage={
              <>
                No contacts match this view.{" "}
                <Link
                  href="/contacts/new"
                  className="underline hover:text-foreground"
                >
                  Add the first one
                </Link>
                .
              </>
            }
          />
        </div>

        {/* Desktop table. */}
        <GlassCard className="mt-6 hidden overflow-hidden p-0 md:block">
          {result.rows.length === 0 ? (
            <p className="p-12 text-center text-sm text-muted-foreground">
              No contacts match this view.{" "}
              <Link
                href="/contacts/new"
                className="underline hover:text-foreground"
              >
                Add the first one
              </Link>
              .
            </p>
          ) : (
            <table className="data-table w-full text-sm">
              <SortableContactsHeaders
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
                        AVAILABLE_CONTACT_COLUMNS.find(
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
                      <ContactRowActions
                        contactId={r.id}
                        contactName={formatPersonName(r)}
                        canDelete={canDeleteContact(user, {
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
    return `/contacts?${params.toString()}`;
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

function renderCell(row: ContactRow, col: ContactColumnKey) {
  switch (col) {
    case "firstName":
      return (
        <Link
          href={`/contacts/${row.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {row.firstName || "(Unnamed)"}
        </Link>
      );
    case "lastName":
      return (
        <span className="text-foreground">{row.lastName ?? "—"}</span>
      );
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
    case "jobTitle":
      return (
        <span className="text-muted-foreground">{row.jobTitle ?? "—"}</span>
      );
    case "email":
      return row.email ? (
        <a
          href={`mailto:${row.email}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {row.email}
        </a>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
    case "phone":
      return <span className="text-muted-foreground">{row.phone ?? "—"}</span>;
    case "mobilePhone":
      return (
        <span className="text-muted-foreground">{row.mobilePhone ?? "—"}</span>
      );
    case "doNotContact":
      return row.doNotContact ? (
        <span className="inline-flex items-center rounded-full border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--status-lost-fg)]">
          DNC
        </span>
      ) : (
        <span className="text-muted-foreground/80">—</span>
      );
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

function BooleanFilterChip({
  name,
  defaultChecked,
  label,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
}) {
  return (
    <label
      className={
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-sm transition focus-within:ring-2 focus-within:ring-ring/40 " +
        (defaultChecked
          ? "border-primary/30 bg-primary/15 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground")
      }
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        value="1"
        className="h-3.5 w-3.5 rounded border-border bg-muted/40 text-primary focus:ring-ring"
      />
      <span>{label}</span>
    </label>
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
    return `/contacts?${params.toString()}`;
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
