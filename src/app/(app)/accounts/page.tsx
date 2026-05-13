import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema/users";
import { savedSearchSubscriptions } from "@/db/schema/saved-search-subscriptions";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { listTags } from "@/lib/tags";
import {
  ACCOUNT_COLUMN_KEYS,
  type AccountColumnKey,
} from "@/lib/account-view-constants";
import {
  findBuiltinAccountView,
  getAccountPreferences,
  getSavedAccountView,
  listAccountIndustries,
  listSavedAccountViewsForUser,
  visibleAccountBuiltins,
  type AccountViewDefinition,
} from "@/lib/account-views";
import { AccountsListClient } from "./_components/accounts-list-client";
import { type AccountViewSummary } from "./view-toolbar";

export const dynamic = "force-dynamic";

interface SearchParams {
  view?: string;
  cols?: string;
}

export default async function AccountsPage({
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
  //   2. user_preferences.default_account_view_id
  //   3. fallback to builtin:my-open
  const prefs = await getAccountPreferences(user.id);
  let activeViewParam = sp.view;
  if (!activeViewParam && prefs.defaultAccountViewId) {
    activeViewParam = `saved:${prefs.defaultAccountViewId}`;
  }
  if (!activeViewParam) activeViewParam = "builtin:my-open";

  const savedViews = await listSavedAccountViewsForUser(user.id);

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

  let activeView: AccountViewDefinition | null = null;
  if (activeViewParam.startsWith("saved:")) {
    const id = activeViewParam.slice("saved:".length);
    activeView = await getSavedAccountView(user.id, id);
    if (!activeView) {
      redirect("/accounts?view=builtin:my-open");
    }
  } else {
    activeView = findBuiltinAccountView(activeViewParam);
    if (activeView?.requiresAllAccounts && !canViewAll) {
      activeView = findBuiltinAccountView("builtin:my-open");
    }
    if (!activeView) activeView = findBuiltinAccountView("builtin:my-open");
  }
  if (!activeView) {
    redirect("/accounts?view=builtin:my-open");
  }

  // ---- Resolve column list -----------------------------------------------
  // URL ?cols= wins, then prefs.adhoc_columns (only on builtin views),
  // else the view's stored column list.
  const baseColumns = activeView.columns;
  const urlCols = sp.cols
    ? (sp.cols
        .split(",")
        .filter((c): c is AccountColumnKey =>
          ACCOUNT_COLUMN_KEYS.includes(c as AccountColumnKey),
        ) as AccountColumnKey[])
    : null;
  let activeColumns: AccountColumnKey[];
  if (urlCols && urlCols.length > 0) {
    activeColumns = urlCols;
  } else if (activeView.source === "builtin" && prefs.adhocColumns?.length) {
    activeColumns = prefs.adhocColumns;
  } else {
    activeColumns = baseColumns;
  }

  // ---- Picker payloads (industries + owners + tags) ----------------------
  const [industries, allTags, ownerPickerRows] = await Promise.all([
    listAccountIndustries({ userId: user.id, canViewAll }),
    listTags(),
    canViewAll
      ? db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(users.isActive, true))
          .orderBy(asc(users.displayName))
          .limit(200)
      : Promise.resolve([]),
  ]);

  const allViews: AccountViewSummary[] = [
    ...visibleAccountBuiltins(canViewAll).map((v) => ({
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

  const savedDirtyId = activeView.source === "saved" ? activeView.id : null;
  const defaultViewIdFull = prefs.defaultAccountViewId
    ? `saved:${prefs.defaultAccountViewId}`
    : null;

  const industryOptions = industries.map((i) => ({ value: i, label: i }));
  const ownerOptions = ownerPickerRows.map((o) => ({
    value: o.id,
    label: o.displayName,
  }));

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={[{ label: "Accounts" }]} />
      <PageRealtime entities={["accounts"]} />
      <PagePoll entities={["accounts"]} />

      <AccountsListClient
        key={activeViewParam}
        user={{ id: user.id, isAdmin: user.isAdmin }}
        timePrefs={timePrefs}
        activeViewParam={activeViewParam}
        activeViewName={activeView.name}
        activeColumns={activeColumns}
        baseColumns={baseColumns}
        views={allViews}
        savedDirtyId={savedDirtyId}
        subscribedViewIds={subscribedViewIds}
        defaultViewId={defaultViewIdFull}
        allTags={allTags.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
        }))}
        ownerOptions={ownerOptions}
        industryOptions={industryOptions}
        canApplyTags={user.isAdmin || perms.canApplyTags}
      />
    </div>
  );
}
