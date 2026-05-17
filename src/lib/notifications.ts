import "server-only";
import { and, count, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema/tasks";
import { userPreferences } from "@/db/schema/views";
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
    // there is no "unread" semantics for something you just did. The
    // bell badge does not use is_read at all (it is `countUnseen`,
    // driven by `notifications_last_seen_at`); is_read is kept
    // accurate here only for a possible future per-row read
    // affordance. The /notifications log shows every row regardless
    // of is_read or last-seen.
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
  // Bell dropdown only (recent N). Served by
  // `notifications_user_created_idx (user_id, created_at DESC)` (a
  // plain composite, not partial): seeks the user's leading rows by
  // user_id and stops at `limit`, cheap even for a 100k+ user. No
  // cursor here — the bell UX is "show recent N"; the /notifications
  // page does its own keyset pagination (listNotificationsCursor).
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/**
 * Topbar bell badge count: the caller's notifications created AFTER
 * their last-seen cursor (`user_preferences.notifications_last_seen_at`).
 * Tracks UNSEEN activity, NOT per-row is_read — activity rows are born
 * is_read=true (they would never move an is_read badge) so the badge
 * had to decouple from is_read. NULL last-seen (never cleared) ⇒ epoch
 * ⇒ counts everything. The notifications scan is index-served by
 * `notifications_user_created_idx (user_id, created_at DESC)`; the
 * last-seen read is a user_preferences PK lookup.
 */
export async function countUnseen(userId: string): Promise<number> {
  const pref = await db
    .select({ at: userPreferences.notificationsLastSeenAt })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const since = pref[0]?.at ?? new Date(0);
  const r = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        gt(notifications.createdAt, since),
      ),
    );
  return r[0]?.n ?? 0;
}

/**
 * Clear the bell badge: advance the caller's last-seen cursor to now.
 * Deliberately does NOT touch any notification row's is_read — the
 * /notifications activity log persists in full regardless of
 * seen/read state. UPSERTs the user_preferences row (a first-time user
 * may not have one yet), mirroring `trackTaskViewSelection`. Single
 * timestamp-cursor write — intentionally NOT version/OCC-guarded; a
 * concurrent two-tab clear just sets the same `now` (last-write-wins,
 * STANDARDS 19.5.3 documented-intent class).
 */
export async function markAllSeen(userId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(userPreferences)
    .values({ userId, notificationsLastSeenAt: now })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { notificationsLastSeenAt: now, updatedAt: now },
    });
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
