import "server-only";
import { logger } from "@/lib/logger";
import { and, count, desc, eq, max, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";

export const ACTIVITY_KINDS_USER = ["note", "call", "task"] as const;
// "email" and "meeting" are wired in Phase 7 via Graph.
export type UserActivityKind = (typeof ACTIVITY_KINDS_USER)[number];

export const noteSchema = z.object({
  leadId: z.string().uuid(),
  body: z.string().trim().min(1, "Note body is required").max(20_000),
});

export const callSchema = z.object({
  leadId: z.string().uuid(),
  subject: z.string().trim().max(240).optional(),
  body: z.string().trim().max(20_000).optional(),
  outcome: z.string().trim().max(120).optional(),
  durationMinutes: z.coerce.number().int().min(0).max(60 * 24).optional(),
  occurredAt: z.string().optional(), // ISO; defaults to now
});

export const taskSchema = z.object({
  leadId: z.string().uuid(),
  subject: z.string().trim().min(1, "Task subject is required").max(240),
  body: z.string().trim().max(20_000).optional(),
  occurredAt: z.string().optional(),
});

export interface ActivityRow {
  id: string;
  // Phase 3G: leadId is nullable now (activities can attach to
  // accounts/contacts/opportunities). The activities CHECK constraint
  // ensures exactly-one-parent, so a row will always have at least one
  // of {leadId, accountId, contactId, opportunityId} set.
  leadId: string | null;
  userId: string | null;
  userDisplayName: string | null;
  kind: string;
  direction: string | null;
  subject: string | null;
  body: string | null;
  occurredAt: Date;
  durationMinutes: number | null;
  outcome: string | null;
  attachments: Array<{
    id: string;
    filename: string;
    blobUrl: string;
    sizeBytes: number | null;
    contentType: string | null;
  }>;
}

export async function listActivitiesForLead(
  leadId: string,
): Promise<ActivityRow[]> {
  const rows = await db
    .select({
      id: activities.id,
      leadId: activities.leadId,
      userId: activities.userId,
      userDisplayName: users.displayName,
      kind: activities.kind,
      direction: activities.direction,
      subject: activities.subject,
      body: activities.body,
      occurredAt: activities.occurredAt,
      durationMinutes: activities.durationMinutes,
      outcome: activities.outcome,
    })
    .from(activities)
    .leftJoin(users, eq(activities.userId, users.id))
    // Phase 10 — exclude soft-deleted activities from every UI surface.
    .where(and(eq(activities.leadId, leadId), eq(activities.isDeleted, false)))
    .orderBy(desc(activities.occurredAt));

  if (rows.length === 0) return [];

  // Hydrate attachments in one query.
  const attachRows = await db
    .select()
    .from(attachments)
    .where(
      sql`${attachments.activityId} IN (${sql.join(
        rows.map((r) => sql`${r.id}::uuid`),
        sql`, `,
      )})`,
    );

  const byActivity = new Map<string, ActivityRow["attachments"]>();
  for (const a of attachRows) {
    const arr = byActivity.get(a.activityId) ?? [];
    arr.push({
      id: a.id,
      filename: a.filename,
      blobUrl: a.blobUrl,
      sizeBytes: a.sizeBytes,
      contentType: a.contentType,
    });
    byActivity.set(a.activityId, arr);
  }

  return rows.map((r) => ({
    ...r,
    attachments: byActivity.get(r.id) ?? [],
  }));
}

async function bumpLastActivityAt(leadId: string): Promise<void> {
  await db
    .update(leads)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(leads.id, leadId));
}

export async function createNote(input: {
  leadId: string;
  userId: string;
  body: string;
}): Promise<{ id: string }> {
  const inserted = await db
    .insert(activities)
    .values({
      leadId: input.leadId,
      userId: input.userId,
      kind: "note",
      body: input.body,
      occurredAt: sql`now()`,
    })
    .returning({ id: activities.id });
  await bumpLastActivityAt(input.leadId);

  // Phase 3D: parse @-mentions and fan out notifications. Failure of
  // mention resolution / notification dispatch must NOT fail the parent
  // create — it's best-effort.
  try {
    const { resolveMentions, filterMentionsByPref } = await import(
      "./mention-parser"
    );
    const mentioned = await resolveMentions(input.body);
    const recipients = await filterMentionsByPref(
      mentioned.filter((m) => m.id !== input.userId).map((m) => m.id),
    );
    if (recipients.length > 0) {
      const { createNotifications } = await import("./notifications");
      await createNotifications(
        recipients.map((rid) => ({
          userId: rid,
          kind: "mention" as const,
          title: "You were mentioned in a note",
          link: `/leads/${input.leadId}`,
        })),
      );
    }
  } catch (err) {
    logger.error("mentions.dispatch_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  return { id: inserted[0].id };
}

export async function createCall(input: {
  leadId: string;
  userId: string;
  subject?: string | null;
  body?: string | null;
  outcome?: string | null;
  durationMinutes?: number | null;
  occurredAt?: Date | null;
}): Promise<{ id: string }> {
  const inserted = await db
    .insert(activities)
    .values({
      leadId: input.leadId,
      userId: input.userId,
      kind: "call",
      direction: "outbound",
      subject: input.subject ?? null,
      body: input.body ?? null,
      outcome: input.outcome ?? null,
      durationMinutes: input.durationMinutes ?? null,
      occurredAt: input.occurredAt ?? sql`now()`,
    })
    .returning({ id: activities.id });
  await bumpLastActivityAt(input.leadId);
  return { id: inserted[0].id };
}

export async function createTask(input: {
  leadId: string;
  userId: string;
  subject: string;
  body?: string | null;
  occurredAt?: Date | null;
}): Promise<{ id: string }> {
  const inserted = await db
    .insert(activities)
    .values({
      leadId: input.leadId,
      userId: input.userId,
      kind: "task",
      subject: input.subject,
      body: input.body ?? null,
      occurredAt: input.occurredAt ?? sql`now()`,
    })
    .returning({ id: activities.id });
  await bumpLastActivityAt(input.leadId);
  return { id: inserted[0].id };
}

/**
 * Phase 10 — soft-delete an activity. Author OR admin can call.
 * Permission re-fetch happens here so the call is safe to make without
 * the caller having pre-loaded the row.
 *
 * After archive, recomputes the parent's last_activity_at when the
 * archived row was the most recent. Activities have an
 * exactly-one-parent CHECK constraint so we look at whichever of
 * {leadId, accountId, contactId, opportunityId} is set. Today only
 * leads have a denormalized last_activity_at column; the others
 * derive it on demand.
 */
export async function softDeleteActivity(
  activityId: string,
  actorUserId: string,
  isAdmin: boolean,
): Promise<{
  parentKind: "lead" | "account" | "contact" | "opportunity" | null;
  parentId: string | null;
}> {
  const [row] = await db
    .select({
      id: activities.id,
      userId: activities.userId,
      leadId: activities.leadId,
      accountId: activities.accountId,
      contactId: activities.contactId,
      opportunityId: activities.opportunityId,
    })
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.isDeleted, false)))
    .limit(1);
  if (!row) return { parentKind: null, parentId: null };
  if (!isAdmin && row.userId !== actorUserId) {
    return { parentKind: null, parentId: null };
  }

  await db
    .update(activities)
    .set({
      isDeleted: true,
      deletedAt: sql`now()`,
      deletedById: actorUserId,
      updatedAt: sql`now()`,
    })
    .where(eq(activities.id, activityId));

  if (row.leadId) {
    const [agg] = await db
      .select({ maxAt: max(activities.occurredAt) })
      .from(activities)
      .where(
        and(eq(activities.leadId, row.leadId), eq(activities.isDeleted, false)),
      );
    await db
      .update(leads)
      .set({ lastActivityAt: agg?.maxAt ?? null })
      .where(eq(leads.id, row.leadId));
    return { parentKind: "lead", parentId: row.leadId };
  }
  if (row.accountId) return { parentKind: "account", parentId: row.accountId };
  if (row.contactId) return { parentKind: "contact", parentId: row.contactId };
  if (row.opportunityId) return { parentKind: "opportunity", parentId: row.opportunityId };
  return { parentKind: null, parentId: null };
}

/**
 * Phase 10 — restore an archived activity (used by the toast Undo).
 * Recomputes parent's last_activity_at after restore.
 */
export async function restoreActivity(
  activityId: string,
  actorUserId: string,
  isAdmin: boolean,
): Promise<{
  parentKind: "lead" | "account" | "contact" | "opportunity" | null;
  parentId: string | null;
}> {
  const [row] = await db
    .select({
      id: activities.id,
      userId: activities.userId,
      leadId: activities.leadId,
      accountId: activities.accountId,
      contactId: activities.contactId,
      opportunityId: activities.opportunityId,
    })
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.isDeleted, true)))
    .limit(1);
  if (!row) return { parentKind: null, parentId: null };
  if (!isAdmin && row.userId !== actorUserId) {
    return { parentKind: null, parentId: null };
  }

  await db
    .update(activities)
    .set({
      isDeleted: false,
      deletedAt: null,
      deletedById: null,
      updatedAt: sql`now()`,
    })
    .where(eq(activities.id, activityId));

  if (row.leadId) {
    const [agg] = await db
      .select({ maxAt: max(activities.occurredAt) })
      .from(activities)
      .where(
        and(eq(activities.leadId, row.leadId), eq(activities.isDeleted, false)),
      );
    await db
      .update(leads)
      .set({ lastActivityAt: agg?.maxAt ?? null })
      .where(eq(leads.id, row.leadId));
    return { parentKind: "lead", parentId: row.leadId };
  }
  if (row.accountId) return { parentKind: "account", parentId: row.accountId };
  if (row.contactId) return { parentKind: "contact", parentId: row.contactId };
  if (row.opportunityId) return { parentKind: "opportunity", parentId: row.opportunityId };
  return { parentKind: null, parentId: null };
}

/**
 * Phase 10 — backwards-compat shim. Old call sites import deleteActivity;
 * forward to softDeleteActivity which now archives rather than dropping.
 */
export async function deleteActivity(
  activityId: string,
  actorUserId: string,
  isAdmin: boolean,
): Promise<void> {
  await softDeleteActivity(activityId, actorUserId, isAdmin);
}

/**
 * Phase 13 — public API parent-verification. Confirms the parent FK
 * exists AND is not soft-deleted. Returns:
 *  - { ok: true }  — parent exists, active.
 *  - { ok: false, reason: 'missing' | 'archived' } — caller emits 422.
 */
export type ParentKind = "lead" | "account" | "contact" | "opportunity";

export async function verifyActivityParent(
  kind: ParentKind,
  parentId: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: "missing" | "archived" }
> {
  const tableMap = {
    lead: leads,
    account: crmAccounts,
    contact: contacts,
    opportunity: opportunities,
  } as const;
  const t = tableMap[kind];
  // All four parent tables share `id` and `is_deleted` columns.
  const [row] = await db
    .select({ id: t.id, isDeleted: t.isDeleted })
    .from(t)
    .where(eq(t.id, parentId))
    .limit(1);
  if (!row) return { ok: false, reason: "missing" };
  if (row.isDeleted) return { ok: false, reason: "archived" };
  return { ok: true };
}

/**
 * Phase 13 — direct insert for /api/v1/activities. Caller MUST pre-verify
 * the parent FK via verifyActivityParent. Bumps lead.last_activity_at
 * when the parent is a lead.
 */
export async function createActivityForApi(input: {
  leadId: string | null;
  accountId: string | null;
  contactId: string | null;
  opportunityId: string | null;
  userId: string;
  kind: "email" | "call" | "meeting" | "note" | "task";
  direction: "inbound" | "outbound" | "internal" | null;
  subject: string | null;
  body: string | null;
  occurredAt: Date | null;
  durationMinutes: number | null;
  outcome: string | null;
}): Promise<{ id: string }> {
  const inserted = await db
    .insert(activities)
    .values({
      leadId: input.leadId,
      accountId: input.accountId,
      contactId: input.contactId,
      opportunityId: input.opportunityId,
      userId: input.userId,
      kind: input.kind,
      direction: input.direction,
      subject: input.subject,
      body: input.body,
      durationMinutes: input.durationMinutes,
      outcome: input.outcome,
      occurredAt: input.occurredAt ?? sql`now()`,
    })
    .returning({ id: activities.id });
  if (input.leadId) {
    await db
      .update(leads)
      .set({ lastActivityAt: sql`now()` })
      .where(eq(leads.id, input.leadId));
  }
  return { id: inserted[0].id };
}

/**
 * Phase 13 — paginated activities listing for /api/v1/activities.
 *
 * Excludes soft-deleted rows. Filters: parent FK (lead/account/contact/
 * opportunity), kind. Owner-scoped on the parent's owner.
 */
export async function listActivitiesForApi(args: {
  leadId?: string;
  accountId?: string;
  contactId?: string;
  opportunityId?: string;
  kind?: string;
  page: number;
  pageSize: number;
  ownerScope: { actorId: string; canViewAll: boolean };
}): Promise<{
  rows: Array<typeof activities.$inferSelect>;
  total: number;
  page: number;
  pageSize: number;
}> {
  const wheres: SQL[] = [eq(activities.isDeleted, false)];
  if (args.leadId) wheres.push(eq(activities.leadId, args.leadId));
  if (args.accountId) wheres.push(eq(activities.accountId, args.accountId));
  if (args.contactId) wheres.push(eq(activities.contactId, args.contactId));
  if (args.opportunityId) {
    wheres.push(eq(activities.opportunityId, args.opportunityId));
  }
  if (args.kind) {
    wheres.push(sql`${activities.kind}::text = ${args.kind}`);
  }
  if (!args.ownerScope.canViewAll) {
    // Limit to activities the user authored. The parent-owner join
    // would also work but is more expensive; this is the MVP.
    wheres.push(eq(activities.userId, args.ownerScope.actorId));
  }
  const where = and(...wheres);
  const offset = (args.page - 1) * args.pageSize;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(activities)
      .where(where)
      .orderBy(desc(activities.occurredAt), desc(activities.id))
      .limit(args.pageSize)
      .offset(offset),
    db.select({ n: count() }).from(activities).where(where),
  ]);

  return {
    rows,
    total: totalRow[0]?.n ?? 0,
    page: args.page,
    pageSize: args.pageSize,
  };
}

export async function getActivityForApi(
  id: string,
  ownerScope: { actorId: string; canViewAll: boolean },
): Promise<typeof activities.$inferSelect | null> {
  const wheres: SQL[] = [
    eq(activities.id, id),
    eq(activities.isDeleted, false),
  ];
  if (!ownerScope.canViewAll) {
    wheres.push(eq(activities.userId, ownerScope.actorId));
  }
  const [row] = await db
    .select()
    .from(activities)
    .where(and(...wheres))
    .limit(1);
  return row ?? null;
}

/**
 * Phase 13 — partial update for /api/v1/activities/:id.
 * activities don't have a version column today, so the OCC `version`
 * field is accepted in the schema for forward-compat but always
 * treated as last-write-wins.
 */
export async function updateActivityForApi(
  id: string,
  patch: Partial<{
    subject: string | null;
    body: string | null;
    outcome: string | null;
    durationMinutes: number | null;
    direction: "inbound" | "outbound" | "internal" | null;
    occurredAt: Date;
  }>,
): Promise<void> {
  await db
    .update(activities)
    .set({
      ...patch,
      updatedAt: sql`now()`,
    })
    .where(and(eq(activities.id, id), eq(activities.isDeleted, false)));
}
