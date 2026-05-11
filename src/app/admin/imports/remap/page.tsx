import { asc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { requireAdmin } from "@/lib/auth-helpers";
import { RemapClient } from "./_components/remap-client";

export const dynamic = "force-dynamic";

/**
 * Phase 25 §7.5 — admin claim-and-remap tool for
 * activities.imported_by_name.
 *
 * Imported D365 activities sometimes carry a "By: <name>" string
 * that didn't resolve to a CRM user at import time (former employee,
 * misspelling, system account). Those rows have userId=NULL and
 * importedByName=<string>. This page lets an admin walk the unique
 * names and remap each to an existing user — every matching
 * activity gets userId set + importedByName cleared, with a
 * forensic audit row per affected activity.
 */
export default async function ClaimAndRemapPage() {
  await requireAdmin();

  // Group pending names by frequency so the admin tackles the most
  // common offenders first.
  const pending = await db
    .select({
      name: activities.importedByName,
      count: sql<number>`count(*)::int`,
      mostRecent: sql<Date>`max(${activities.createdAt})`,
    })
    .from(activities)
    .where(
      sql`${activities.importedByName} IS NOT NULL AND ${activities.userId} IS NULL AND ${activities.isDeleted} = false`,
    )
    .groupBy(activities.importedByName)
    .orderBy(sql`count(*) DESC`);

  const allUsers = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
    })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(asc(users.displayName));

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Imports", href: "/admin/imports" },
          { label: "Imported-by remap" },
        ]}
      />
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Admin · Imports
      </p>
      <h1 className="mt-1 text-2xl font-semibold">Imported-by remap</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Imported activities whose &quot;By: …&quot; name didn&apos;t resolve to
        a CRM user are listed below, grouped by the snapshot string. Pick the
        matching user; every activity for that name gets <code>user_id</code>
        set and <code>imported_by_name</code> cleared.
      </p>

      <GlassCard className="mt-6 p-4">
        <RemapClient pending={pending} users={allUsers} />
      </GlassCard>
    </div>
  );
}

// `isNull` and `isNotNull` are unused at top-scope but kept imported in
// case the page extends with additional filters. Reference them so the
// lint pass doesn't strip the imports.
void isNull;
void isNotNull;
