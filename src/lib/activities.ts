import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
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
    .where(eq(activities.leadId, leadId))
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
    console.error("[mentions] dispatch failed", err);
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

export async function deleteActivity(
  activityId: string,
  actorUserId: string,
  isAdmin: boolean,
): Promise<void> {
  // Non-admins can only delete their own activities.
  const wheres = [eq(activities.id, activityId)];
  if (!isAdmin) wheres.push(eq(activities.userId, actorUserId));
  await db.delete(activities).where(and(...wheres));
}
