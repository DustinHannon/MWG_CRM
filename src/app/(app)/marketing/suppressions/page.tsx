import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardEmptyState, StandardPageHeader } from "@/components/standard";
import { marketingSuppressions } from "@/db/schema/marketing-events";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";
import { AddSuppressionDialog } from "./_components/add-suppression-dialog";
import { RemoveSuppressionButton } from "./_components/remove-suppression-button";

export const dynamic = "force-dynamic";

interface SearchParams {
  source?: string;
}

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "unsubscribe", label: "Unsubscribe" },
  { value: "group_unsubscribe", label: "Group unsubscribe" },
  { value: "bounce", label: "Bounce" },
  { value: "block", label: "Block" },
  { value: "spamreport", label: "Spam report" },
  { value: "invalid", label: "Invalid" },
  { value: "manual", label: "Manual" },
] as const;

type SourceValue = (typeof SOURCE_OPTIONS)[number]["value"];

function isSourceValue(v: string | undefined): v is SourceValue {
  if (!v) return false;
  return SOURCE_OPTIONS.some((o) => o.value === v);
}

/**
 * Suppressions view. Most rows are mirrored from SendGrid via the
 * hourly cron + event webhook. Admins with the manual-add permission
 * can also suppress an address directly from this page; admins with
 * the manual-remove permission can re-subscribe an address with a
 * recorded reason.
 */
export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canMarketingSuppressionsView) {
    redirect("/marketing");
  }

  const sp = await searchParams;
  const source: SourceValue = isSourceValue(sp.source) ? sp.source : "all";

  const where: SQL | undefined =
    source === "all"
      ? undefined
      : eq(marketingSuppressions.suppressionType, source);

  const rows = await db
    .select({
      email: marketingSuppressions.email,
      suppressionType: marketingSuppressions.suppressionType,
      reason: marketingSuppressions.reason,
      suppressedAt: marketingSuppressions.suppressedAt,
      syncedAt: marketingSuppressions.syncedAt,
      addedByUserId: marketingSuppressions.addedByUserId,
      addedByName: users.displayName,
    })
    .from(marketingSuppressions)
    .leftJoin(users, eq(users.id, marketingSuppressions.addedByUserId))
    .where(where ? and(where) : undefined)
    .orderBy(desc(marketingSuppressions.suppressedAt))
    .limit(500);

  const canAdd = user.isAdmin || perms.canMarketingSuppressionsAdd;
  const canRemove = user.isAdmin || perms.canMarketingSuppressionsRemove;

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.suppressionsIndex()} />
      <StandardPageHeader
        title="Suppressions"
        description={
          <>
            Mirror of SendGrid&apos;s suppression list, reconciled hourly.
            Admins can manually suppress or re-subscribe an address from
            here.
          </>
        }
        actions={canAdd ? <AddSuppressionDialog /> : undefined}
      />

      <SourceFilter currentSource={source} />

      {rows.length === 0 ? (
        <StandardEmptyState
          title="No suppressed addresses match"
          description={
            source === "all"
              ? "All recipients are receiving marketing email."
              : "Try a different source filter."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Email
                  </th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Source
                  </th>
                  <th className="px-4 py-3 text-left font-medium">Reason</th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Added at
                  </th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">
                    Added by
                  </th>
                  {canRemove ? (
                    <th className="px-4 py-3 text-right font-medium whitespace-nowrap">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.email} className="align-top">
                    <td className="px-4 py-3 font-mono text-xs text-foreground">
                      {r.email}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.suppressionType}
                    </td>
                    <td
                      className="max-w-[28ch] truncate px-4 py-3 text-muted-foreground"
                      title={r.reason ?? undefined}
                    >
                      {r.reason ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      <UserTime value={r.suppressedAt} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {r.addedByName ?? (
                        <span className="italic text-muted-foreground/70">
                          system
                        </span>
                      )}
                    </td>
                    {canRemove ? (
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <RemoveSuppressionButton
                          email={r.email}
                          source={r.suppressionType}
                          suppressedAt={r.suppressedAt.toISOString()}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceFilter({ currentSource }: { currentSource: SourceValue }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-muted/40 p-3">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        Source
      </span>
      <div className="flex flex-wrap gap-1">
        {SOURCE_OPTIONS.map((option) => {
          const active = option.value === currentSource;
          const href =
            option.value === "all"
              ? "/marketing/suppressions"
              : `/marketing/suppressions?source=${option.value}`;
          return (
            <Link
              key={option.value}
              href={href}
              className={`inline-flex min-h-[32px] items-center rounded-full border px-3 py-1 text-xs transition ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
