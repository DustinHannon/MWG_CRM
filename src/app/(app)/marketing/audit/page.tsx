import Link from "next/link";
import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { StandardPageHeader } from "@/components/standard";
import { UserTime } from "@/components/ui/user-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { marketingCrumbs } from "@/lib/navigation/marketing-breadcrumbs";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

interface Props {
  searchParams: Promise<{
    page?: string;
    user?: string;
    from?: string;
    to?: string;
    type?: string;
  }>;
}

/**
 * Phase 21 — Marketing audit log subtab. Server-component paginated
 * listing of every `marketing.*` event in `audit_log`. Filters surface
 * via query params (`?user`, `?from`, `?to`, `?type`).
 *
 * Marketing role required (the layout enforces `canManageMarketing`).
 * Admin can filter by other users; non-admin only sees their own
 * actions plus system-fired events.
 */
export default async function MarketingAuditPage({ searchParams }: Props) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  // Layout already gates on `canManageMarketing`; defensive check.
  if (!user.isAdmin && !perms.canManageMarketing) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        You don&apos;t have access to the marketing audit log.
      </div>
    );
  }

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Build conditions. Always require marketing.* prefix.
  const conditions = [ilike(auditLog.action, "marketing.%")];

  // Non-admin users can only view their own actions + system-fired
  // events (no actor). Admin can pass `?user=<id>` to scope to anyone.
  if (!user.isAdmin) {
    conditions.push(
      sql`(${auditLog.actorId} = ${user.id} OR ${auditLog.actorId} IS NULL)`,
    );
  } else if (sp.user) {
    conditions.push(eq(auditLog.actorId, sp.user));
  }

  if (sp.type) {
    // Match by full event type or its prefix (e.g. `marketing.campaign`).
    const t = sp.type.startsWith("marketing.") ? sp.type : `marketing.${sp.type}`;
    conditions.push(ilike(auditLog.action, `${t}%`));
  }

  if (sp.from) {
    const d = new Date(sp.from);
    if (!Number.isNaN(d.getTime())) {
      conditions.push(gte(auditLog.createdAt, d));
    }
  }
  if (sp.to) {
    const d = new Date(sp.to);
    if (!Number.isNaN(d.getTime())) {
      conditions.push(lte(auditLog.createdAt, d));
    }
  }

  const rows = await db
    .select({
      id: auditLog.id,
      actorId: auditLog.actorId,
      actorEmailSnapshot: auditLog.actorEmailSnapshot,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      beforeJson: auditLog.beforeJson,
      afterJson: auditLog.afterJson,
      createdAt: auditLog.createdAt,
      actorDisplayName: users.displayName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(PAGE_SIZE)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(...conditions));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter crumbs={marketingCrumbs.auditIndex()} />
      <Link
        href="/marketing"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to marketing
      </Link>

      <StandardPageHeader
        kicker="Marketing audit"
        title="Marketing audit log"
        description={
          <>
            Forensic record of every marketing template, list, campaign, and
            suppression action.
          </>
        }
        actions={
          <Link
            href="/marketing/reports/email"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm font-medium text-foreground whitespace-nowrap transition hover:bg-muted"
          >
            <BarChart3 className="h-4 w-4" aria-hidden />
            Marketing email report
          </Link>
        }
      />

      <FilterBar
        currentUser={sp.user ?? ""}
        currentFrom={sp.from ?? ""}
        currentTo={sp.to ?? ""}
        currentType={sp.type ?? ""}
        adminCanFilterUser={user.isAdmin}
      />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">
          No marketing audit events match these filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Timestamp</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">User</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Event</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Target</th>
                <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Metadata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.createdAt} />
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {r.actorDisplayName ??
                      r.actorEmailSnapshot ??
                      "system"}
                  </td>
                  <td className="px-4 py-3">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                      {r.action}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <TargetCell
                      targetType={r.targetType}
                      targetId={r.targetId}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <MetadataCell
                      before={r.beforeJson}
                      after={r.afterJson}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {totalPages > 1 ? (
        <Pagination page={page} totalPages={totalPages} sp={sp} />
      ) : null}
    </div>
  );
}

function FilterBar({
  currentUser,
  currentFrom,
  currentTo,
  currentType,
  adminCanFilterUser,
}: {
  currentUser: string;
  currentFrom: string;
  currentTo: string;
  currentType: string;
  adminCanFilterUser: boolean;
}) {
  return (
    <form
      method="GET"
      className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-muted/40 p-4"
    >
      {adminCanFilterUser ? (
        <div className="flex flex-col gap-1">
          <label
            htmlFor="user"
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
          >
            User ID
          </label>
          <input
            id="user"
            name="user"
            type="text"
            defaultValue={currentUser}
            placeholder="UUID"
            className="w-56 rounded-md border border-border bg-input px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="type"
          className="text-[11px] uppercase tracking-wide text-muted-foreground"
        >
          Event prefix
        </label>
        <input
          id="type"
          name="type"
          type="text"
          defaultValue={currentType}
          placeholder="campaign or template.update"
          className="w-56 rounded-md border border-border bg-input px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="from"
          className="text-[11px] uppercase tracking-wide text-muted-foreground"
        >
          From
        </label>
        <input
          id="from"
          name="from"
          type="datetime-local"
          defaultValue={currentFrom}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="to"
          className="text-[11px] uppercase tracking-wide text-muted-foreground"
        >
          To
        </label>
        <input
          id="to"
          name="to"
          type="datetime-local"
          defaultValue={currentTo}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
        >
          Apply
        </button>
        <Link
          href="/marketing/audit"
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
        >
          Reset
        </Link>
      </div>
    </form>
  );
}

function TargetCell({
  targetType,
  targetId,
}: {
  targetType: string | null;
  targetId: string | null;
}) {
  if (!targetType || !targetId) return <>—</>;
  const href = targetTypeToHref(targetType, targetId);
  if (!href) {
    return (
      <span className="text-xs">
        {targetType} <code className="text-[10px]">{targetId}</code>
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="text-xs text-foreground hover:underline"
      title={`${targetType} ${targetId}`}
    >
      {targetType}
    </Link>
  );
}

function targetTypeToHref(targetType: string, targetId: string): string | null {
  switch (targetType) {
    case "marketing_campaign":
      return `/marketing/campaigns/${targetId}`;
    case "marketing_template":
      return `/marketing/templates/${targetId}`;
    case "marketing_list":
      return `/marketing/lists/${targetId}`;
    default:
      return null;
  }
}

function MetadataCell({
  before,
  after,
}: {
  before: unknown;
  after: unknown;
}) {
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  if (!hasBefore && !hasAfter) {
    return <span className="text-xs text-muted-foreground/60">—</span>;
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground transition hover:text-foreground">
        Inspect
      </summary>
      <div className="mt-2 flex flex-col gap-1 text-[11px]">
        {hasBefore ? (
          <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-foreground/80">
            <span className="text-muted-foreground">before:</span>{" "}
            {JSON.stringify(before, null, 2)}
          </pre>
        ) : null}
        {hasAfter ? (
          <pre className="overflow-x-auto rounded bg-muted/60 p-2 text-foreground/80">
            <span className="text-muted-foreground">after:</span>{" "}
            {JSON.stringify(after, null, 2)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}

function Pagination({
  page,
  totalPages,
  sp,
}: {
  page: number;
  totalPages: number;
  sp: Awaited<Props["searchParams"]>;
}) {
  const make = (target: number): string => {
    const params = new URLSearchParams();
    params.set("page", String(target));
    if (sp.user) params.set("user", sp.user);
    if (sp.from) params.set("from", sp.from);
    if (sp.to) params.set("to", sp.to);
    if (sp.type) params.set("type", sp.type);
    return `/marketing/audit?${params.toString()}`;
  };

  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>
        Page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Link
            href={make(page - 1)}
            className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs hover:bg-muted"
          >
            Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={make(page + 1)}
            className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs hover:bg-muted"
          >
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}
