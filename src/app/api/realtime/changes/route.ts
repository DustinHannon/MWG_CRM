import { NextResponse } from "next/server";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { tasks, notifications } from "@/db/schema/tasks";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { combine, withActive } from "@/lib/db/query-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RealtimeEntity =
  | "leads"
  | "accounts"
  | "contacts"
  | "opportunities"
  | "tasks"
  | "activities"
  | "notifications";

const ALLOWED: ReadonlySet<RealtimeEntity> = new Set([
  "leads",
  "accounts",
  "contacts",
  "opportunities",
  "tasks",
  "activities",
  "notifications",
]);

const MAX_IDS_PER_ENTITY = 200;

/**
 * polling endpoint for the useRealtimePoll hook.
 *
 * GET /api/realtime/changes?entities=leads,accounts&since=<iso>
 *
 * Returns the IDs of records (within the viewer's allowed scope) whose
 * `updated_at` is greater than `since`, plus a `lastChangeAt` cursor
 * the client uses for the next call.
 *
 * The endpoint never returns row contents — only IDs. The full row
 * data comes from the page's Server Component re-render after the
 * client calls router.refresh().
 *
 * Scope filtering uses the same access pattern as the list pages, so a
 * user without can_view_all_records won't see other people's row IDs
 * in this response either.
 */
export async function GET(req: Request) {
  const user = await requireSession();
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since") ?? "";
  const entitiesParam = url.searchParams.get("entities") ?? "";

  let since: Date;
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "bad-since" }, { status: 400 });
    }
    since = parsed;
  } else {
    since = new Date(Date.now() - 30_000);
  }

  const requested = entitiesParam
    .split(",")
    .map((s) => s.trim() as RealtimeEntity)
    .filter((s) => ALLOWED.has(s));

  if (requested.length === 0) {
    return NextResponse.json({ error: "no-entities" }, { status: 400 });
  }

  const perms = await getPermissions(user.id);
  const canViewAll = user.isAdmin || perms.canViewAllRecords;
  const out: Partial<Record<RealtimeEntity, string[]>> = {};
  let lastChangeAt = since;

  const wantSet = new Set<RealtimeEntity>(requested);

  if (wantSet.has("leads")) {
    const where = combine(
      gt(leads.updatedAt, since),
      withActive(leads.isDeleted),
      canViewAll ? undefined : eq(leads.ownerId, user.id),
    );
    const rows = await db
      .select({ id: leads.id, ts: leads.updatedAt })
      .from(leads)
      .where(where)
      .orderBy(desc(leads.updatedAt))
      .limit(MAX_IDS_PER_ENTITY);
    out.leads = rows.map((r) => r.id);
    for (const r of rows) if (r.ts > lastChangeAt) lastChangeAt = r.ts;
  }

  if (wantSet.has("accounts")) {
    const where = combine(
      gt(crmAccounts.updatedAt, since),
      withActive(crmAccounts.isDeleted),
      canViewAll ? undefined : eq(crmAccounts.ownerId, user.id),
    );
    const rows = await db
      .select({ id: crmAccounts.id, ts: crmAccounts.updatedAt })
      .from(crmAccounts)
      .where(where)
      .orderBy(desc(crmAccounts.updatedAt))
      .limit(MAX_IDS_PER_ENTITY);
    out.accounts = rows.map((r) => r.id);
    for (const r of rows) if (r.ts > lastChangeAt) lastChangeAt = r.ts;
  }

  if (wantSet.has("contacts")) {
    const where = combine(
      gt(contacts.updatedAt, since),
      withActive(contacts.isDeleted),
      canViewAll ? undefined : eq(contacts.ownerId, user.id),
    );
    const rows = await db
      .select({ id: contacts.id, ts: contacts.updatedAt })
      .from(contacts)
      .where(where)
      .orderBy(desc(contacts.updatedAt))
      .limit(MAX_IDS_PER_ENTITY);
    out.contacts = rows.map((r) => r.id);
    for (const r of rows) if (r.ts > lastChangeAt) lastChangeAt = r.ts;
  }

  if (wantSet.has("opportunities")) {
    const where = combine(
      gt(opportunities.updatedAt, since),
      withActive(opportunities.isDeleted),
      canViewAll ? undefined : eq(opportunities.ownerId, user.id),
    );
    const rows = await db
      .select({ id: opportunities.id, ts: opportunities.updatedAt })
      .from(opportunities)
      .where(where)
      .orderBy(desc(opportunities.updatedAt))
      .limit(MAX_IDS_PER_ENTITY);
    out.opportunities = rows.map((r) => r.id);
    for (const r of rows) if (r.ts > lastChangeAt) lastChangeAt = r.ts;
  }

  if (wantSet.has("tasks")) {
    // Tasks scope to assignee for non-privileged users.
    const where = combine(
      gt(tasks.updatedAt, since),
      withActive(tasks.isDeleted),
      canViewAll ? undefined : eq(tasks.assignedToId, user.id),
    );
    const rows = await db
      .select({ id: tasks.id, ts: tasks.updatedAt })
      .from(tasks)
      .where(where)
      .orderBy(desc(tasks.updatedAt))
      .limit(MAX_IDS_PER_ENTITY);
    out.tasks = rows.map((r) => r.id);
    for (const r of rows) if (r.ts > lastChangeAt) lastChangeAt = r.ts;
  }

  if (wantSet.has("activities")) {
    // Activities visibility is parent-scoped (lead/account/contact/opp).
    // Recomputing that join per poll for non-privileged users would be
    // expensive; for v1, only privileged viewers get cross-record
    // activity-change ids. Detail-page timelines work via router.refresh()
    // since the page itself is already gated.
    if (canViewAll) {
      const where = combine(
        gt(activities.updatedAt, since),
        withActive(activities.isDeleted),
      );
      const rows = await db
        .select({ id: activities.id, ts: activities.updatedAt })
        .from(activities)
        .where(where)
        .orderBy(desc(activities.updatedAt))
        .limit(MAX_IDS_PER_ENTITY);
      out.activities = rows.map((r) => r.id);
      for (const r of rows) if (r.ts > lastChangeAt) lastChangeAt = r.ts;
    } else {
      out.activities = [];
    }
  }

  if (wantSet.has("notifications")) {
    const rows = await db
      .select({ id: notifications.id, ts: notifications.createdAt })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, user.id),
          gt(notifications.createdAt, since),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(MAX_IDS_PER_ENTITY);
    out.notifications = rows.map((r) => r.id);
    for (const r of rows) if (r.ts > lastChangeAt) lastChangeAt = r.ts;
  }

  // Advance cursor by 1ms so the client never re-asks "since the same
  // instant" repeatedly.
  if (lastChangeAt.getTime() === since.getTime()) {
    lastChangeAt = new Date(since.getTime() + 1);
  }

  return NextResponse.json({
    entities: out,
    lastChangeAt: lastChangeAt.toISOString(),
  });
}
