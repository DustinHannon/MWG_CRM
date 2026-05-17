import "server-only";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema/tasks";
import { users } from "@/db/schema/users";
import { logger } from "@/lib/logger";

interface CreateNotificationInput {
  userId: string;
  kind:
    | "task_assigned"
    | "task_due"
    | "mention"
    | "saved_search"
    | "new_user_jit"
    | "mailbox_blocked"
    | "activity";
  title: string;
  body?: string | null;
  link?: string | null;
}

/**
 * Insert a single notification. Bell icon picks it up on next poll/render.
 * Falls back silently on failure — a missed notification shouldn't fail
 * the parent action.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<void> {
  try {
    await db.insert(notifications).values({
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    });
  } catch (err) {
    logger.error("notifications.create_failed", {
      userId: input.userId,
      kind: input.kind,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function createNotifications(
  list: CreateNotificationInput[],
): Promise<void> {
  if (list.length === 0) return;
  try {
    await db.insert(notifications).values(
      list.map((n) => ({
        userId: n.userId,
        kind: n.kind,
        title: n.title,
        body: n.body ?? null,
        link: n.link ?? null,
      })),
    );
  } catch (err) {
    logger.error("notifications.bulk_create_failed", {
      count: list.length,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Verbs surfaced in the activity feed. Past tense, sentence case. */
export type ActivityVerb = "Added" | "Updated" | "Archived" | "Restored";
export type ActivityEntityType =
  | "lead"
  | "contact"
  | "account"
  | "opportunity"
  | "task";

const ACTIVITY_ENTITY_LABEL: Record<ActivityEntityType, string> = {
  lead: "Lead",
  contact: "Contact",
  account: "Account",
  opportunity: "Opportunity",
  task: "Task",
};

export interface EmitActivityInput {
  /** The user who performed the action — their own activity feed. */
  actorId: string;
  verb: ActivityVerb;
  entityType: ActivityEntityType;
  entityId: string;
  /**
   * Human label resolved at emit time ("Dustin Hannon"); snapshotted
   * because the entity may be archived/renamed/hard-deleted later.
   */
  entityDisplayName: string;
  /** In-app jump target, e.g. `/leads/{id}`. */
  link: string;
}

function activityRow(i: EmitActivityInput) {
  const label = ACTIVITY_ENTITY_LABEL[i.entityType];
  const name = i.entityDisplayName.trim() || `(unnamed ${i.entityType})`;
  return {
    userId: i.actorId,
    actorId: i.actorId,
    kind: "activity" as const,
    // Born read: an activity row records the actor's OWN action —
    // there is no "unread" semantics for something you just did. This
    // keeps these rows out of the is_read-based bell badge
    // (`countUnread`) which has no kind filter; the badge tracks
    // unseen activity via `notifications_last_seen_at` instead, and
    // the /notifications log shows every row regardless of is_read.
    isRead: true as const,
    title: `${i.verb} ${name} — ${label}`,
    verb: i.verb,
    entityType: i.entityType,
    entityId: i.entityId,
    entityDisplayName: name,
    link: i.link,
  };
}

/**
 * Record a state-changing action in the actor's OWN activity feed
 * (bell + /notifications). Best-effort — mirrors writeAudit's
 * contract: a failure here NEVER fails the parent mutation (swallow
 * + logger.error). Call it next to writeAudit at create / archive /
 * restore / key-field-update sites.
 */
export async function emitActivity(input: EmitActivityInput): Promise<void> {
  try {
    await db.insert(notifications).values(activityRow(input));
  } catch (err) {
    logger.error("notifications.emit_activity_failed", {
      actorId: input.actorId,
      entityType: input.entityType,
      entityId: input.entityId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Chunk size for {@link emitActivities}. Mirrors
 * `AUDIT_BATCH_CHUNK_SIZE` (src/lib/audit.ts): a bulk task/entity
 * action can reach `BULK_SCOPE_EXPANSION_CAP` (5000) rows, so a single
 * INSERT would be one oversized statement and let one bad row
 * (jsonb/length/constraint) poison all N. 500 caps the blast radius
 * to its chunk and bounds params/round-trips (§19.6.3 / §19.7.2
 * parity with writeAuditBatch).
 */
const ACTIVITY_BATCH_CHUNK_SIZE = 500;

/**
 * Batch variant for bulk actions — one row per entity, chunked at
 * {@link ACTIVITY_BATCH_CHUNK_SIZE}. Same best-effort contract as
 * {@link emitActivity}: a chunk-INSERT failure NEVER blocks the
 * parent mutation; it logs the chunk and continues so a single bad
 * row only loses its chunk, not the whole feed batch.
 */
export async function emitActivities(
  list: EmitActivityInput[],
): Promise<void> {
  if (list.length === 0) return;
  for (let i = 0; i < list.length; i += ACTIVITY_BATCH_CHUNK_SIZE) {
    const chunk = list.slice(i, i + ACTIVITY_BATCH_CHUNK_SIZE);
    try {
      await db.insert(notifications).values(chunk.map(activityRow));
    } catch (err) {
      logger.error("notifications.emit_activities_failed", {
        actorId: chunk[0]?.actorId ?? null,
        sampleEntityType: chunk[0]?.entityType ?? null,
        chunkIndex: i / ACTIVITY_BATCH_CHUNK_SIZE,
        chunkSize: chunk.length,
        totalEvents: list.length,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function listNotificationsForUser(
  userId: string,
  limit = 20,
) {
  // verified cursor-friendly: queries the composite partial
  // index `notifications_user_unread_idx (user_id, is_read, created_at DESC)`
  // and is bounded by `limit`, so even a high-volume user (100k+
  // notifications) seeks the leading rows by user_id and stops early.
  // No cursor parameter is exposed because the bell + /notifications
  // page UX is "show recent N"; pagination beyond the top N would
  // need a redesign (mark-read-as-you-scroll behaviour, etc).
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function countUnread(userId: string): Promise<number> {
  const r = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
    );
  return r[0]?.n ?? 0;
}

export async function markAllRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
    );
}

export async function markRead(id: string, userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

/**
 * fan out a "new user joined" bell notification to every active
 * admin. Called from the JIT provisioning path AFTER the user-create
 * transaction commits. Defensive: a query failure logs and returns
 * silently so a notification miss never bubbles up to fail the sign-in.
 */
export async function notifyAdminsOfNewUser(args: {
  userId: string;
  displayName: string;
  email: string;
}): Promise<void> {
  try {
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isAdmin, true), eq(users.isActive, true)));

    if (admins.length === 0) return;

    await createNotifications(
      admins.map((a) => ({
        userId: a.id,
        kind: "new_user_jit" as const,
        title: `New user joined: ${args.displayName}`,
        body: `${args.email} signed in for the first time. Standard permissions applied.`,
        link: `/admin/users/${args.userId}`,
      })),
    );
  } catch (err) {
    logger.error("notifications.new_user_jit_failed", {
      newUserId: args.userId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
