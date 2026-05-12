import Link from "next/link";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { clickdimensionsMigrations } from "@/db/schema/clickdimensions-migrations";
import { permissions } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { adminCrumbs } from "@/lib/navigation/breadcrumbs";
import { requireSession } from "@/lib/auth-helpers";
import { redirect } from "next/navigation";
import { StandardPageHeader } from "@/components/standard";

export const dynamic = "force-dynamic";

/**
 * Admin migrations landing page. Today only the
 * ClickDimensions worklist lives under this tree; future external
 * migrations (HubSpot, Marketo) would surface here too.
 */
export default async function AdminMigrationsPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    const perm = await db
      .select({
        canMarketingMigrationsRun: permissions.canMarketingMigrationsRun,
      })
      .from(permissions)
      .where(eq(permissions.userId, user.id))
      .limit(1);
    if (!perm[0]?.canMarketingMigrationsRun) {
      redirect("/dashboard");
    }
  }

  const totals = await db
    .select({ value: count() })
    .from(clickdimensionsMigrations);
  const total = Number(totals[0]?.value ?? 0);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={adminCrumbs.migrationsIndex()} />
      <StandardPageHeader
        title="Migrations"
        description="External-source imports that run outside the in-app D365 pipeline."
      />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/admin/migrations/clickdimensions"
          className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <GlassCard className="h-full p-5 hover:bg-muted/30 transition">
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium text-foreground">
                ClickDimensions templates
              </div>
              <div className="text-xs text-muted-foreground">
                Worklist of templates extracted from the legacy
                ClickDimensions UI in D365.
              </div>
              <div className="mt-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {total} {total === 1 ? "row" : "rows"}
              </div>
            </div>
          </GlassCard>
        </Link>
      </div>
    </div>
  );
}
