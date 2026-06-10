import "server-only";
import { logger } from "@/lib/logger";
import { and, count, desc, eq, max, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { NotFoundError } from "@/lib/errors";
import { expectAffected } from "@/lib/db/concurrent-update";
import { activities, attachments } from "@/db/schema/activities";
import { contacts, crmAccounts, opportunities } from "@/db/schema/crm-records";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";

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

// Inline-edit form schemas for the lead timeline. Field rules mirror
// the create schemas above (same trim/length limits — single source of
// truth for what's valid) minus `leadId` (the action re-fetches the
// activity and trusts the DB parent, never a client claim) plus the
// edit identity: `activityId` + the OCC `version` the client loaded.
// `version` is coerced because it arrives as a hidden form string.
//
// These are parsed with `parseFormOrThrow(..., { emptyMode: "keep" })`
// to match the canonical entity-update actions (account/contact/
// opportunity) — a present-but-empty field reaches the schema so the
// schema, not ad-hoc `?? null` in the action, decides clearing. The
// call-edit optional fields therefore carry the same clear-on-empty
// `.transform()` the sibling update schemas use for nullable columns
// (`""` → `null`), so emptying a field persists `NULL` exactly as the
// prior `"exact"` + `?? null` path did. Note `body` keeps `.min(1)`:
// under `"keep"` a blank body still reaches the schema and is rejected
// (never silently nulled) — clearing a note's body is not allowed.
const editIdentity = {
  activityId: z.string().uuid(),
  version: z.coerce.number().int().min(1),
};
// `""` (or whitespace-only) → null; otherwise the trimmed value. Mirrors
// the canonical entity-update schemas' nullable-field transform so the
// column is cleared by the schema, not by the action.
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null));
export const noteEditSchema = z.object({
  ...editIdentity,
  // Same rule as `noteSchema.body`: required, blank rejected (not nulled).
  body: z.string().trim().min(1, "Note body is required").max(20_000),
});
export const callEditSchema = z.object({
  ...editIdentity,
  subject: clearableText(240),
  body: clearableText(20_000),
  outcome: clearableText(120),
  // Empty duration clears the column; a present value is the same
  // coerced non-negative int the create schema enforces.
  durationMinutes: z
    .union([z.literal(""), z.coerce.number().int().min(0).max(60 * 24)])
    .optional()
    .nullable()
    .transform((v) => (v === "" || v === undefined || v === null ? null : v)),
  occurredAt: z
    .string()
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)), // ISO; null clears
});

// Lead Add-task tab form schema. Limits MUST match the canonical
// `taskCreateSchema` (@/lib/tasks: title ≤200, description ≤2000) so
// this layer-1 parse rejects an over-length value first — if a value
// passed here but failed the canonical parse in addTaskAction, the
// boundary's raw-ZodError path would drop the `values` echo and blank
// the form on submit. Single validation source of truth.
export const taskSchema = z.object({
  leadId: z.string().uuid(),
  subject: z.string().trim().min(1, "Task subject is required").max(200),
  body: z.string().trim().max(2000).optional(),
  occurredAt: z.string().optional(),
});

export interface ActivityRow {
  id: string;
  // leadId is nullable now (activities can attach to
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
  // OCC token the inline-edit form submits back unchanged.
  version: number;
  // Provenance flags. The timeline shows the inline-edit affordance
  // only for free-form note/call rows that are NOT Graph-synced or
  // D365-imported — identical to `updateActivityAction`'s server gate.
  graphMessageId: string | null;
  graphEventId: string | null;
  importDedupKey: string | null;
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
      version: activities.version,
      graphMessageId: activities.graphMessageId,
      graphEventId: activities.graphEventId,
      importDedupKey: activities.importDedupKey,
    })
    .from(activities)
    .leftJoin(users, eq(activities.userId, users.id))
    // exclude soft-deleted activities from every UI surface.
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

  // parse @-mentions and fan out notifications. Failure of
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

/**
 * soft-delete an activity. Author OR admin can call.
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

  // Wrap the activity flip and the lead.last_activity_at recompute in
  // one transaction so a transient failure on the lead-side UPDATE
  // cannot leave the activity archived while the parent lead still
  // shows it as the most recent activity. Without the tx, scoring
  // recency and the leads list "Last activity" column would drift.
  await db.transaction(async (tx) => {
    await tx
      .update(activities)
      .set({
        isDeleted: true,
        deletedAt: sql`now()`,
        deletedById: actorUserId,
        updatedAt: sql`now()`,
      })
      .where(eq(activities.id, activityId));

    if (row.leadId) {
      const [agg] = await tx
        .select({ maxAt: max(activities.occurredAt) })
        .from(activities)
        .where(
          and(
            eq(activities.leadId, row.leadId),
            eq(activities.isDeleted, false),
          ),
        );
      await tx
        .update(leads)
        .set({ lastActivityAt: agg?.maxAt ?? null })
        .where(eq(leads.id, row.leadId));
    }
  });

  if (row.leadId) return { parentKind: "lead", parentId: row.leadId };
  if (row.accountId) return { parentKind: "account", parentId: row.accountId };
  if (row.contactId) return { parentKind: "contact", parentId: row.contactId };
  if (row.opportunityId) return { parentKind: "opportunity", parentId: row.opportunityId };
  return { parentKind: null, parentId: null };
}

/**
 * restore an archived activity (used by the toast Undo).
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

  // Same transactional bracket as softDeleteActivity — the activity
  // restore and the parent's lastActivityAt recompute must commit
  // together, or the parent's "Last activity" denormalized field
  // silently lies until the next activity bumps it.
  await db.transaction(async (tx) => {
    await tx
      .update(activities)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        // Clear delete_reason so a now-live row never carries a stale
        // cascade sentinel. If this activity was cascade-archived by a
        // parent (delete_reason = '__cascade__:<parent>:<id>') and the
        // user individually restores just it, the marker no longer
        // applies; leaving it would mislead a forensic reviewer and
        // diverges from every cascade restore + restoreTasksById,
        // which all null delete_reason on restore (M-2 / cascade
        // contract consistency).
        deleteReason: null,
        updatedAt: sql`now()`,
        // OCC bump on restore mirrors archive + update; without it, a
        // concurrent edit-from-stale-version after restore would silently
        // win (updateActivity gates on version = expectedVersion AND
        // is_deleted = false, both of which re-match after an
        // archive->restore cycle that leaves version unchanged). Symmetric
        // with restoreLeadsById.
        version: sql`${activities.version} + 1`,
      })
      .where(eq(activities.id, activityId));

    if (row.leadId) {
      const [agg] = await tx
        .select({ maxAt: max(activities.occurredAt) })
        .from(activities)
        .where(
          and(
            eq(activities.leadId, row.leadId),
            eq(activities.isDeleted, false),
          ),
        );
      await tx
        .update(leads)
        .set({ lastActivityAt: agg?.maxAt ?? null })
        .where(eq(leads.id, row.leadId));
    }
  });

  if (row.leadId) return { parentKind: "lead", parentId: row.leadId };
  if (row.accountId) return { parentKind: "account", parentId: row.accountId };
  if (row.contactId) return { parentKind: "contact", parentId: row.contactId };
  if (row.opportunityId) return { parentKind: "opportunity", parentId: row.opportunityId };
  return { parentKind: null, parentId: null };
}

/**
 * public API parent-verification. Confirms the parent FK
 * exists AND is not soft-deleted. Returns:
 * { ok: true } — parent exists, active.
 * { ok: false, reason: 'missing' | 'archived' } — caller emits 422.
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
 * direct insert for /api/v1/activities. Caller MUST pre-verify
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
 * paginated activities listing for /api/v1/activities.
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

/** Mutable fields a note/call inline edit (app action) or the API
 *  PATCH may change. `kind`/parent/graph-link columns are intentionally
 *  not here — identity and provenance are immutable post-create. */
export type ActivityUpdatePatch = Partial<{
  subject: string | null;
  body: string | null;
  outcome: string | null;
  durationMinutes: number | null;
  direction: "inbound" | "outbound" | "internal" | null;
  occurredAt: Date;
}>;

export type ActivitySelect = typeof activities.$inferSelect;

/**
 * Single canonical OCC update for an activity, used by BOTH the (app)
 * `updateActivityAction` and the public `PATCH /api/v1/activities/:id`
 * route — no fork. Activities now carry a `version` column (STANDARDS
 * §19.5), so this is genuine optimistic concurrency, not the prior
 * last-write-wins `updateActivityForApi`.
 *
 * OCC is enforced atomically by the `version = expectedVersion`
 * predicate on the UPDATE itself (no read-then-write race — same shape
 * as `updateTask`). The pre-update row is read only to give the caller
 * a `before` for the audit. `expectAffected` turns an empty result
 * into a typed `ConflictError` (row exists, version moved) or
 * `NotFoundError` (row absent / already archived).
 *
 * Returns `{ before, after }` so the caller writes a complete audit
 * (before AND after) — the prior API path audited `after` only.
 */
export async function updateActivity(args: {
  id: string;
  patch: ActivityUpdatePatch;
  expectedVersion: number;
  actorId: string;
}): Promise<{ before: ActivitySelect; after: ActivitySelect }> {
  const { id, patch, expectedVersion, actorId } = args;

  const [before] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, id), eq(activities.isDeleted, false)))
    .limit(1);
  if (!before) throw new NotFoundError("activity");

  const rows = await db
    .update(activities)
    .set({
      ...patch,
      // actor stamp for realtime skip-self.
      updatedById: actorId,
      updatedAt: sql`now()`,
      version: sql`${activities.version} + 1`,
    })
    .where(
      and(
        eq(activities.id, id),
        eq(activities.isDeleted, false),
        eq(activities.version, expectedVersion),
      ),
    )
    .returning();
  // empty rows + row exists -> ConflictError (stale version);
  // empty rows + row absent -> NotFoundError. Non-empty -> no-op.
  await expectAffected(rows, {
    table: activities,
    id,
    entityLabel: "activity",
  });

  return { before, after: rows[0] };
}
