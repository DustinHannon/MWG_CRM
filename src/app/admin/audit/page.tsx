import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { users } from "@/db/schema/users";
import { UserTime } from "@/components/ui/user-time";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; action?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? "1"));
  const offset = (page - 1) * PAGE_SIZE;

  const wheres = [];
  if (sp.q && sp.q.trim()) {
    const pattern = `%${sp.q.trim()}%`;
    wheres.push(
      or(
        ilike(auditLog.action, pattern),
        ilike(auditLog.targetType, pattern),
        ilike(auditLog.targetId, pattern),
        ilike(users.displayName, pattern),
        ilike(users.email, pattern),
      ),
    );
  }
  if (sp.action) wheres.push(eq(auditLog.action, sp.action));
  const where = wheres.length > 0 ? and(...wheres) : undefined;

  const rows = await db
    .select({
      id: auditLog.id,
      actorId: auditLog.actorId,
      actorDisplayName: users.displayName,
      actorEmail: users.email,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      beforeJson: auditLog.beforeJson,
      afterJson: auditLog.afterJson,
      requestId: auditLog.requestId,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(where)
    .orderBy(desc(auditLog.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const totalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .where(where);
  const total = totalRow[0]?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="px-10 py-10">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {total} {total === 1 ? "event" : "events"} recorded. Append-only.
      </p>

      <form className="mt-6 flex flex-wrap gap-3">
        <input
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="Search action / target / actor…"
          className="min-w-[280px] flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <input
          name="action"
          defaultValue={sp.action ?? ""}
          placeholder="Action (e.g. lead.update)"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <button
          type="submit"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
        >
          Apply
        </button>
      </form>

      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-muted/40 backdrop-blur-xl">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">When</th>
              <th className="px-5 py-3 font-medium">Actor</th>
              <th className="px-5 py-3 font-medium">Action</th>
              <th className="px-5 py-3 font-medium">Target</th>
              <th className="px-5 py-3 font-medium">Diff</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-muted-foreground">
                  No audit events match.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-5 py-3 text-xs text-muted-foreground tabular-nums">
                  <UserTime value={r.createdAt} />
                </td>
                <td className="px-5 py-3">
                  {r.actorDisplayName ? (
                    <>
                      <span className="text-foreground">{r.actorDisplayName}</span>
                      <div className="text-[10px] text-muted-foreground/80">{r.actorEmail}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground/80">system</span>
                  )}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-foreground/90">
                  {r.action}
                </td>
                <td className="px-5 py-3 text-xs text-muted-foreground">
                  {r.targetType ? (
                    <>
                      <span className="text-foreground/90">{r.targetType}</span>
                      {r.targetId ? (
                        <div className="font-mono text-[10px] text-muted-foreground/80">
                          {r.targetId}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-5 py-3 text-xs text-muted-foreground">
                  {r.beforeJson || r.afterJson ? (
                    <details>
                      <summary className="cursor-pointer text-foreground/80 underline-offset-4 hover:underline">
                        view
                      </summary>
                      <pre className="mt-2 max-w-md overflow-x-auto rounded bg-black/30 p-2 font-mono text-[10px] text-foreground/90">
                        {JSON.stringify(
                          { before: r.beforeJson, after: r.afterJson },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <nav className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <PageLink sp={sp} target={page - 1}>← Previous</PageLink>
            ) : null}
            {page < totalPages ? (
              <PageLink sp={sp} target={page + 1}>Next →</PageLink>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function PageLink({
  sp,
  target,
  children,
}: {
  sp: { q?: string; action?: string };
  target: number;
  children: React.ReactNode;
}) {
  const params = new URLSearchParams();
  if (sp.q) params.set("q", sp.q);
  if (sp.action) params.set("action", sp.action);
  params.set("page", String(target));
  return (
    <a
      href={`/admin/audit?${params.toString()}`}
      className="rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
    >
      {children}
    </a>
  );
}
