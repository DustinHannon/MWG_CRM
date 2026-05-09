import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { PagePoll } from "@/components/realtime/page-poll";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { ArchivedListMobile } from "@/components/archived/archived-list-mobile";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { UserChip } from "@/components/user-display";
import { requireSession } from "@/lib/auth-helpers";
import {
  hardDeleteTaskAction,
  restoreTaskAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * Phase 10 — admin-only archived tasks view.
 */
export default async function ArchivedTasksPage() {
  const user = await requireSession();
  if (!user.isAdmin) {
    return (
      <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
        <BreadcrumbsSetter
          crumbs={[
            { label: "Tasks", href: "/tasks" },
            { label: "Archived" },
          ]}
        />
        <p className="text-sm text-muted-foreground">Admin only.</p>
      </div>
    );
  }

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      deletedAt: tasks.deletedAt,
      reason: tasks.deleteReason,
      deletedById: tasks.deletedById,
      deletedByEmail: users.email,
      deletedByName: users.displayName,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.deletedById))
    .where(eq(tasks.isDeleted, true))
    .orderBy(desc(tasks.deletedAt))
    .limit(200);

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Tasks", href: "/tasks" },
          { label: "Archived" },
        ]}
      />
      <PageRealtime entities={["tasks"]} />
      <PagePoll entities={["tasks"]} />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Archived tasks
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Hidden from the main views.
          </p>
        </div>
        <Link
          href="/tasks"
          className="text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground/90"
        >
          ← Back to tasks
        </Link>
      </div>

      {rows.length === 0 ? (
        <GlassCard className="px-6 py-10 text-center text-sm text-muted-foreground">
          No archived tasks.
        </GlassCard>
      ) : (
        <>
        {/* Phase 12 — dense single-line list at <md, mirrors /leads. */}
        <div className="md:hidden">
          <ArchivedListMobile
            rows={rows.map((r) => ({
              id: r.id,
              title: r.title,
              subtitle: null,
              deletedAt: r.deletedAt,
              deletedByName: r.deletedByName,
              deletedByEmail: r.deletedByEmail,
              reason: r.reason,
            }))}
            renderActions={(row) => (
              <>
                <form
                  action={async (fd) => {
                    "use server";
                    await restoreTaskAction(fd);
                  }}
                >
                  <input type="hidden" name="id" value={row.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 hover:bg-muted"
                  >
                    Restore
                  </button>
                </form>
                <form
                  action={async (fd) => {
                    "use server";
                    await hardDeleteTaskAction(fd);
                  }}
                >
                  <input type="hidden" name="id" value={row.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)] hover:bg-destructive/30"
                  >
                    Delete permanently
                  </button>
                </form>
              </>
            )}
          />
        </div>

        <GlassCard className="hidden overflow-hidden p-0 md:block">
          <table className="data-table w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground/80">
              <tr>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Archived</th>
                <th className="px-4 py-3">By</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-accent/40">
                  <td data-label="Title" className="px-4 py-3 font-medium text-foreground">
                    {r.title}
                  </td>
                  <td data-label="Archived" className="px-4 py-3 text-muted-foreground">
                    <UserTime value={r.deletedAt} mode="date" />
                  </td>
                  <td data-label="By" className="px-4 py-3">
                    {r.deletedById ? (
                      <UserChip
                        user={{
                          id: r.deletedById,
                          displayName: r.deletedByName,
                          photoUrl: null,
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground">
                        {r.deletedByEmail ?? "—"}
                      </span>
                    )}
                  </td>
                  <td data-label="Reason" className="px-4 py-3 text-muted-foreground">{r.reason ?? "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <form
                        action={async (fd) => {
                          "use server";
                          await restoreTaskAction(fd);
                        }}
                      >
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 hover:bg-muted"
                        >
                          Restore
                        </button>
                      </form>
                      <form
                        action={async (fd) => {
                          "use server";
                          await hardDeleteTaskAction(fd);
                        }}
                      >
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-1.5 text-xs text-[var(--status-lost-fg)] hover:bg-destructive/30"
                        >
                          Delete permanently
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlassCard>
        </>
      )}
    </div>
  );
}
