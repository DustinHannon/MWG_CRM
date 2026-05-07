import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { tags as tagsTable, leadTags } from "@/db/schema/tags";
import { tasks } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import {
  getCurrentUserTimePrefs,
  UserTime,
} from "@/components/ui/user-time";
import { formatUserTime } from "@/lib/format-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { getLeadById } from "@/lib/leads";
import { formatPersonName } from "@/lib/format/person-name";
import "./print.css";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Print preview",
  robots: { index: false },
};

/**
 * Phase 4F — print-friendly lead detail. Lives outside the `(app)` route
 * group so the sidebar/topbar/glass chrome isn't rendered. Browser-print
 * first: no server-side Chromium dependency. The user picks "Save as PDF"
 * from the system print dialog.
 *
 * URL: /leads/print/[id]
 */
export default async function LeadPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const { id } = await params;
  const lead = await getLeadById(user, id, perms.canViewAllRecords);
  if (!lead) notFound();
  const prefs = await getCurrentUserTimePrefs();

  const [acts, leadTagsRows, taskRows, fileRows] = await Promise.all([
    db
      .select({
        id: activities.id,
        kind: activities.kind,
        direction: activities.direction,
        subject: activities.subject,
        body: activities.body,
        occurredAt: activities.occurredAt,
        actorName: users.displayName,
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.userId))
      .where(eq(activities.leadId, id))
      .orderBy(activities.occurredAt),
    db
      .select({ name: tagsTable.name, color: tagsTable.color })
      .from(leadTags)
      .innerJoin(tagsTable, eq(tagsTable.id, leadTags.tagId))
      .where(eq(leadTags.leadId, id)),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .where(eq(tasks.leadId, id))
      .orderBy(desc(tasks.dueAt))
      .limit(50),
    db
      .select({ id: attachments.id, filename: attachments.filename })
      .from(attachments)
      .innerJoin(activities, eq(activities.id, attachments.activityId))
      .where(eq(activities.leadId, id)),
  ]);

  return (
    <div className="print-root">
      <button
        type="button"
        data-print-hide
        className="print-hide-btn"
        // Server component can't have onClick; rely on auto-print or
        // browser keyboard shortcut. Auto-print fires from the script tag below.
      >
        Use your browser&apos;s Save as PDF in the print dialog
      </button>

      <h1>
        {formatPersonName(lead)}
      </h1>
      <div className="meta">
        {lead.companyName ? `${lead.companyName} · ` : ""}
        Status: {lead.status} · Score: {lead.score} ({lead.scoreBand})
      </div>

      <section>
        <h2>Details</h2>
        <dl>
          <dt>Email</dt>
          <dd>
            {lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : "—"}
          </dd>
          <dt>Phone</dt>
          <dd>{lead.phone ?? "—"}</dd>
          <dt>Mobile</dt>
          <dd>{lead.mobilePhone ?? "—"}</dd>
          <dt>Website</dt>
          <dd>
            {lead.website ? <a href={lead.website}>{lead.website}</a> : "—"}
          </dd>
          <dt>Industry</dt>
          <dd>{lead.industry ?? "—"}</dd>
          <dt>Job title</dt>
          <dd>{lead.jobTitle ?? "—"}</dd>
          <dt>Estimated value</dt>
          <dd>{lead.estimatedValue ?? "—"}</dd>
          <dt>Estimated close</dt>
          <dd>
            <UserTime value={lead.estimatedCloseDate} mode="date" />
          </dd>
          <dt>Created</dt>
          <dd>
            <UserTime value={lead.createdAt} />
          </dd>
          <dt>Updated</dt>
          <dd>
            <UserTime value={lead.updatedAt} />
          </dd>
        </dl>
      </section>

      {leadTagsRows.length > 0 && (
        <section>
          <h2>Tags</h2>
          <div>
            {leadTagsRows.map((t) => (
              <span key={t.name} className="tag">
                {t.name}
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Activity history ({acts.length})</h2>
        {acts.length === 0 && <p>No activity yet.</p>}
        {acts.map((a) => (
          <div key={a.id} className="activity">
            <div className="activity-head">
              {String(a.kind)}
              {a.direction ? ` · ${String(a.direction)}` : ""}
              {" · "}
              <UserTime value={a.occurredAt} />
              {a.actorName ? ` · ${a.actorName}` : ""}
            </div>
            {a.subject && <div className="activity-subject">{a.subject}</div>}
            {a.body && <div className="activity-body">{a.body}</div>}
          </div>
        ))}
      </section>

      <section>
        <h2>Tasks ({taskRows.length})</h2>
        {taskRows.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {taskRows.map((t) => (
              <li key={t.id}>
                <strong>[{t.status}]</strong> {t.title}
                {t.dueAt
                  ? ` (due ${formatUserTime(t.dueAt, prefs, "date")})`
                  : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Files ({fileRows.length})</h2>
        {fileRows.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {fileRows.map((f) => (
              <li key={f.id}>{f.filename}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="footer">
        Printed by {user.displayName ?? user.email} on{" "}
        <UserTime value={new Date()} />
      </div>

      <script
        // Auto-open the print dialog on load. The user can cancel and
        // re-trigger via the browser shortcut.
        dangerouslySetInnerHTML={{
          __html:
            "window.addEventListener('load',function(){setTimeout(function(){window.print()},250)});",
        }}
      />
    </div>
  );
}
