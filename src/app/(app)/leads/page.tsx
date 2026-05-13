import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import {
  COLUMN_KEYS,
  type ColumnKey,
} from "@/lib/view-constants";
import {
  findBuiltinView,
  getPreferences,
  getSavedView,
  listSavedViewsForUser,
  type ViewDefinition,
  visibleBuiltins,
} from "@/lib/views";
import { listTags } from "@/lib/tags";
import { LeadsListClient } from "./_components/leads-list-client";
import { ViewToolbar, type ViewSummary } from "./view-toolbar";

export const dynamic = "force-dynamic";

interface SearchParams {
  view?: string;
  cols?: string;
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
  // Precedence:
  //   1. ?view= explicit
  //   2. user_preferences.default_leads_view_id
  //   3. user_preferences.last_used_view_id
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
      redirect("/leads?view=builtin:my-open");
    }
  } else {
    activeView = findBuiltinView(activeViewParam);
    if (activeView?.requiresAllLeads && !canViewAll) {
      activeView = findBuiltinView("builtin:my-open");
    }
    if (!activeView) activeView = findBuiltinView("builtin:my-open");
  }
  if (!activeView) {
    redirect("/leads?view=builtin:my-open");
  }

  // ---- Resolve column list -----------------------------------------------
  // URL ?cols= wins, then prefs.adhoc_columns (only on builtin views), else
  // the view's stored column list.
  const baseColumns = activeView.columns;
  const urlCols = sp.cols
    ? (sp.cols
        .split(",")
        .filter((c): c is ColumnKey =>
          COLUMN_KEYS.includes(c as ColumnKey),
        ) as ColumnKey[])
    : null;
  let activeColumns: ColumnKey[];
  if (urlCols && urlCols.length > 0) {
    activeColumns = urlCols;
  } else if (activeView.source === "builtin" && prefs.adhocColumns?.length) {
    activeColumns = prefs.adhocColumns;
  } else {
    activeColumns = baseColumns;
  }

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

  // Filter / sort / search modification is now owned by the client
  // component. The server-side modification flag covers only column
  // drift; the client-side state never round-trips through the URL
  // so it cannot trigger a "MODIFIED" badge today. Future work:
  // surface filter modification via a separate pill driven by client
  // state (see follow-up notes).
  const viewModified = columnsModified;
  const modifiedFields: string[] = [];
  if (columnsModified) modifiedFields.push("columns");

  const savedDirtyId = activeView.source === "saved" ? activeView.id : null;

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Leads" }]} />
      <PageRealtime entities={["leads"]} />
      <PagePoll entities={["leads"]} />

      {/* ViewToolbar is desktop-only — view selector, MODIFIED badge,
          Save-as-new, Columns chooser are all power-user features
          that don't fit the mobile toolbar. */}
      <div className="mb-4 hidden md:block">
        <ViewToolbar
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
        />
      </div>

      <LeadsListClient
        key={activeViewParam}
        user={{ id: user.id, isAdmin: user.isAdmin }}
        timePrefs={timePrefs}
        activeViewParam={activeViewParam}
        activeColumns={activeColumns}
        allTags={allTags.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
        }))}
        canApplyTags={user.isAdmin || perms.canApplyTags}
        canMarketingListsBulkAdd={
          user.isAdmin || perms.canMarketingListsBulkAdd
        }
        canImport={user.isAdmin || perms.canImport}
        canExport={user.isAdmin || perms.canExport}
        canCreateLeads={user.isAdmin || perms.canCreateLeads}
      />
    </div>
  );
}
