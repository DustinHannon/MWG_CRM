"use server";

import { revalidatePath } from "next/cache";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import {
  callEditSchema,
  callSchema,
  createCall,
  createNote,
  noteEditSchema,
  noteSchema,
  restoreActivity,
  softDeleteActivity,
  taskSchema,
  updateActivity,
} from "@/lib/activities";
import { createTask, taskCreateSchema } from "@/lib/tasks";
import { createNotification } from "@/lib/notifications";
import { userPreferences } from "@/db/schema/views";
import { writeAudit } from "@/lib/audit";
import {
  requireLeadAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { eq } from "drizzle-orm";
import { canDeleteActivity, canEditActivity } from "@/lib/access/can-delete";
import { parseFormOrThrow } from "@/lib/forms/form-data";
import { getCurrentUserTimePrefs } from "@/components/ui/user-time";

/**
 * Parse a `datetime-local` `occurredAt` (carries the user-entered wall
 * clock, e.g. `2026-05-22T14:30`). `new Date("...T00:00:00")` interprets
 * a zoneless string in the RUNTIME timezone. This is only used for the
 * call-log `When` field, whose value is a full local datetime the user
 * typed; do NOT route a date-only `YYYY-MM-DD` due date through here —
 * see `parseDueDateInUserTz` (the runtime is `TZ=UTC` on Vercel, so a
 * bare date would anchor to UTC midnight, not the user's, and render a
 * day early).
 */
function parseOccurredAt(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value,
  );
  // occurredAt is only z.string() (no format check); an unparseable
  // value must become null, not an Invalid Date that the timestamp
  // column rejects with an opaque 500.
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Convert a date-only `YYYY-MM-DD` task due date to the UTC instant for
 * **00:00 in the user's timezone** — the same instant the canonical
 * client paths (`entity-tasks-quick-add`, `task-edit-dialog`) store by
 * doing `new Date("${date}T00:00:00")` in the browser (Central), and
 * the exact inverse of the `formatUserTime` display path. `fromZonedTime`
 * treats the zoneless wall clock as local time in `timeZone` and is
 * DST-aware, so this is correct under any server `TZ` (Vercel is
 * `TZ=UTC`) for both CDT and CST dates. `timeZone` MUST be the same
 * source the display uses (`getCurrentUserTimePrefs().timezone`, default
 * `America/Chicago`) so entry → store → render round-trips.
 *
 * A non-`YYYY-MM-DD` value (the `Due date` input is `type="date"`, so
 * this should not occur) or an unparseable one yields `null`, mirroring
 * `parseOccurredAt` — never an Invalid Date the column rejects with a 500.
 */
function parseDueDateInUserTz(
  value: string | undefined,
  timeZone: string,
): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = fromZonedTime(`${value}T00:00:00`, timeZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function addNoteAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.note_create" }, async () => {
    const user = await requireSession();
    const parsed = parseFormOrThrow(noteSchema, formData, {
      emptyMode: "exact",
    });
    // Lead access gate — actor must own the lead OR have canViewAllRecords.
    await requireLeadAccess(user, parsed.leadId);
    const { id } = await createNote({
      leadId: parsed.leadId,
      userId: user.id,
      body: parsed.body,
    });
    await writeAudit({
      actorId: user.id,
      action: "activity.note_create",
      targetType: "activity",
      targetId: id,
      after: { body: parsed.body.slice(0, 500) },
    });
    revalidatePath(`/leads/${parsed.leadId}`);
  });
}

export async function addCallAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.call_create" }, async () => {
    const user = await requireSession();
    const parsed = parseFormOrThrow(callSchema, formData, {
      emptyMode: "exact",
    });
    await requireLeadAccess(user, parsed.leadId);
    const { id } = await createCall({
      leadId: parsed.leadId,
      userId: user.id,
      subject: parsed.subject ?? null,
      body: parsed.body ?? null,
      outcome: parsed.outcome ?? null,
      durationMinutes: parsed.durationMinutes ?? null,
      occurredAt: parseOccurredAt(parsed.occurredAt),
    });
    await writeAudit({
      actorId: user.id,
      action: "activity.call_create",
      targetType: "activity",
      targetId: id,
      after: {
        subject: parsed.subject ?? null,
        outcome: parsed.outcome ?? null,
        durationMinutes: parsed.durationMinutes ?? null,
      },
    });
    revalidatePath(`/leads/${parsed.leadId}`);
  });
}

/**
 * Inline-edit a note or call timeline entry with full optimistic
 * concurrency. Author OR admin only (re-fetched, never trusts the
 * client). Strictly gated to `kind in ('note','call')` — email,
 * meeting, task, and any Graph-/import-provenanced row (a synced or
 * imported activity) are rejected: those bodies are system-owned, not
 * free-form user prose, and editing them would desync the source. The
 * submitted `version` is the OCC token; a concurrent edit surfaces as
 * a ConflictError envelope the form turns into the conflict dialog.
 */
export async function updateActivityAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.update" }, async () => {
    const user = await requireSession();
    const activityId = z.string().uuid().parse(formData.get("activityId"));

    // Re-fetch — never trust the client's claimed kind/parent/author.
    const [row] = await db
      .select({
        id: activities.id,
        leadId: activities.leadId,
        userId: activities.userId,
        kind: activities.kind,
        version: activities.version,
        isDeleted: activities.isDeleted,
        graphMessageId: activities.graphMessageId,
        graphEventId: activities.graphEventId,
        importDedupKey: activities.importDedupKey,
      })
      .from(activities)
      .where(eq(activities.id, activityId))
      .limit(1);
    if (!row || row.isDeleted) {
      throw new ForbiddenError("Activity not found.");
    }
    // This action only edits lead-attached note/call entries; the
    // timeline edit affordance is only rendered there.
    if (!row.leadId) {
      throw new ValidationError("This activity can't be edited here.");
    }
    await requireLeadAccess(user, row.leadId);
    if (!canEditActivity(user, row)) {
      await writeAudit({
        actorId: user.id,
        action: "access.denied.activity.update",
        targetType: "activity",
        targetId: activityId,
      });
      throw new ForbiddenError("You can't edit this activity.");
    }

    // Strict kind gate — only free-form note/call prose is editable.
    if (row.kind !== "note" && row.kind !== "call") {
      throw new ValidationError(
        "Only notes and calls can be edited.",
      );
    }
    // Provenance gate — a Graph-synced or D365-imported row is owned by
    // its source; editing it would silently diverge from that source.
    if (row.graphMessageId || row.graphEventId || row.importDedupKey) {
      throw new ValidationError(
        "Synced or imported activities can't be edited.",
      );
    }

    // Parse with the kind-specific edit schema (field rules mirror the
    // create schemas; see noteEditSchema/callEditSchema in @/lib/
    // activities); pick by the DB-confirmed kind.
    if (row.kind === "note") {
      // emptyMode:"keep" — canonical entity-update parse mode. A blank
      // body still reaches `noteEditSchema.body` (.min(1)) and is
      // rejected, never silently nulled.
      const parsed = parseFormOrThrow(noteEditSchema, formData, {
        emptyMode: "keep",
      });
      const { before, after } = await updateActivity({
        id: activityId,
        patch: { body: parsed.body },
        expectedVersion: parsed.version,
        actorId: user.id,
      });
      await writeAudit({
        actorId: user.id,
        action: "activity.update",
        targetType: "activity",
        targetId: activityId,
        before,
        after,
      });
    } else {
      // emptyMode:"keep" — canonical entity-update parse mode. The
      // call-edit schema's clear-on-empty transforms already yield
      // `null` for an emptied subject/body/outcome/duration (column
      // cleared by the schema, not by ad-hoc `?? null` here), so the
      // patch passes the parsed values through unchanged. `occurredAt`
      // is null when empty; `parseOccurredAt(... ?? undefined)` then
      // returns null, and `?? undefined` omits it from the patch so an
      // empty date leaves the column unchanged — identical to the
      // prior "exact" behavior (empty was skipped → field unchanged).
      const parsed = parseFormOrThrow(callEditSchema, formData, {
        emptyMode: "keep",
      });
      const { before, after } = await updateActivity({
        id: activityId,
        patch: {
          subject: parsed.subject,
          body: parsed.body,
          outcome: parsed.outcome,
          durationMinutes: parsed.durationMinutes,
          occurredAt: parseOccurredAt(parsed.occurredAt ?? undefined) ?? undefined,
        },
        expectedVersion: parsed.version,
        actorId: user.id,
      });
      await writeAudit({
        actorId: user.id,
        action: "activity.update",
        targetType: "activity",
        targetId: activityId,
        before,
        after,
      });
    }

    revalidatePath(`/leads/${row.leadId}`);
  });
}

/**
 * Read-only fetch of an activity's current editable state, used solely
 * by the inline-edit form to populate the OCC conflict dialog when a
 * save loses the version race (the canonical occ-conflict-dialog is
 * presentation-only — loading server state to diff against is the
 * caller's job). Gated by the SAME rule as `updateActivityAction`: the
 * actor must have lead access (`requireLeadAccess`) AND be the activity
 * author or an admin (`canEditActivity`). The edit path is deliberately
 * stricter than delete — delete (`canDeleteActivity`) does not check
 * lead access — so this read gate must enforce both to ensure it can't
 * surface an activity the actor couldn't already edit.
 */
export async function getActivityForConflictAction(input: {
  activityId: string;
}): Promise<
  ActionResult<{
    version: number;
    subject: string | null;
    body: string | null;
    outcome: string | null;
    durationMinutes: number | null;
    occurredAt: string;
  }>
> {
  return withErrorBoundary({ action: "activity.conflict_state" }, async () => {
    const user = await requireSession();
    const activityId = z.string().uuid().parse(input.activityId);
    const [row] = await db
      .select({
        leadId: activities.leadId,
        userId: activities.userId,
        isDeleted: activities.isDeleted,
        version: activities.version,
        subject: activities.subject,
        body: activities.body,
        outcome: activities.outcome,
        durationMinutes: activities.durationMinutes,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .where(eq(activities.id, activityId))
      .limit(1);
    if (!row || row.isDeleted) {
      throw new ForbiddenError("Activity not found.");
    }
    // Match `updateActivityAction`'s gate exactly: lead-attached only,
    // then lead access, then author-or-admin. The edit path requires
    // lead access (stricter than delete) — enforce it here too so this
    // read can't surface an activity the actor couldn't edit.
    if (!row.leadId) {
      throw new ValidationError("This activity can't be edited here.");
    }
    await requireLeadAccess(user, row.leadId);
    if (!canEditActivity(user, row)) {
      throw new ForbiddenError("You can't edit this activity.");
    }
    return {
      version: row.version,
      subject: row.subject,
      body: row.body,
      outcome: row.outcome,
      durationMinutes: row.durationMinutes,
      occurredAt: row.occurredAt.toISOString(),
    };
  });
}

/**
 * Add-task tab on the lead detail actions panel. This creates a REAL
 * `tasks` row via the canonical task path (`@/lib/tasks.createTask`) —
 * NOT an `activities kind:"task"` row. The activities-row variant had
 * no due_at/status/assignee, so it never reached /tasks, the dashboard
 * "My open tasks", the saved-search digest, or the tasks-due-today
 * cron — the reminder silently never fired. Subject→title, Details→
 * description, Due date→dueAt; the task is self-assigned to the actor
 * (the lead actions panel has no assignee picker). `createTask`
 * already writes the `task.create` audit (`targetType:"tasks"`) and
 * emits the timeline activity, so this action only adds the
 * assignee-notification (no-op while self-assigned, kept for parity
 * with `createTaskAction`) + revalidation. The form still parses via
 * `taskSchema` so its ValidationError carries the raw `values` the
 * React-19 reset-restore in TaskForm depends on.
 */
export async function addTaskAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "task.create" }, async () => {
    const user = await requireSession();
    const form = parseFormOrThrow(taskSchema, formData, {
      emptyMode: "exact",
    });
    await requireLeadAccess(user, form.leadId);

    // The `Due date` field is `type="date"` → a bare `YYYY-MM-DD`.
    // Anchor it to 00:00 in the user's timezone (the same source the
    // display path reads), not the runtime's — Vercel runs `TZ=UTC`, so
    // parsing it as runtime-local would store UTC midnight and render a
    // day early in Central. `getCurrentUserTimePrefs` is the canonical
    // single source for the user/app timezone.
    const { timezone } = await getCurrentUserTimePrefs();
    const input = taskCreateSchema.parse({
      title: form.subject,
      description: form.body ?? null,
      dueAt: parseDueDateInUserTz(form.occurredAt, timezone),
      assignedToId: user.id,
      leadId: form.leadId,
    });
    await createTask(input, user.id);

    // Parity with createTaskAction: notify the assignee when it is not
    // the actor. Self-assigned here (no picker on the panel), so this
    // is a no-op today; kept so a future assignee field stays correct.
    if (input.assignedToId && input.assignedToId !== user.id) {
      const prefs = await db
        .select({ notify: userPreferences.notifyTasksAssigned })
        .from(userPreferences)
        .where(eq(userPreferences.userId, input.assignedToId))
        .limit(1);
      if (prefs[0]?.notify !== false) {
        await createNotification({
          userId: input.assignedToId,
          kind: "task_assigned",
          title: `New task: ${input.title}`,
          link: `/leads/${form.leadId}`,
        });
      }
    }

    revalidatePath(`/leads/${form.leadId}`);
    revalidatePath("/tasks");
  });
}

/**
 * soft-delete an activity. Author OR admin only. Permission
 * is enforced both client-gated (UI hides the trigger) and server-gated
 * (this action re-fetches the activity and verifies userId match or
 * admin). Returns an undo token for the toast.
 */
export async function softDeleteActivityAction(input: {
  activityId: string;
}): Promise<ActionResult<{ undoToken: string }>> {
  return withErrorBoundary(
    { action: "activity.archive", entityType: "activity", entityId: input.activityId },
    async (): Promise<{ undoToken: string }> => {
      const user = await requireSession();
      const activityId = z.string().uuid().parse(input.activityId);

      // Re-fetch — never trust the client claim.
      const [row] = await db
        .select({
          id: activities.id,
          userId: activities.userId,
          leadId: activities.leadId,
          subject: activities.subject,
          kind: activities.kind,
        })
        .from(activities)
        .where(eq(activities.id, activityId))
        .limit(1);
      if (!row) throw new ForbiddenError("Activity not found.");
      if (!canDeleteActivity(user, row)) {
        await writeAudit({
          actorId: user.id,
          action: "access.denied.activity.delete",
          targetType: "activity",
          targetId: activityId,
        });
        throw new ForbiddenError("You can't archive this activity.");
      }

      const { parentKind, parentId } = await softDeleteActivity(
        activityId,
        user.id,
        user.isAdmin,
      );
      await writeAudit({
        actorId: user.id,
        action: "activity.archive",
        targetType: "activity",
        targetId: activityId,
        before: { userId: row.userId, kind: row.kind, subject: row.subject, leadId: row.leadId },
      });

      if (parentKind && parentId) {
        revalidatePath(`/${parentKind}s/${parentId}`);
      }
      return {
        undoToken: signUndoToken({
          entity: "activity",
          id: activityId,
          deletedAt: new Date(),
        }),
      };
    },
  );
}

export async function undoArchiveActivityAction(input: {
  undoToken: string;
}): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.unarchive_undo" }, async () => {
    const user = await requireSession();
    const payload = verifyUndoToken(input.undoToken);
    if (payload.entity !== "activity") throw new ForbiddenError("Token mismatch.");
    const { parentKind, parentId } = await restoreActivity(
      payload.id,
      user.id,
      user.isAdmin,
    );
    await writeAudit({
      actorId: user.id,
      action: "activity.unarchive_undo",
      targetType: "activity",
      targetId: payload.id,
    });
    if (parentKind && parentId) {
      revalidatePath(`/${parentKind}s/${parentId}`);
    }
  });
}

/**
 * backwards-compat for the legacy form-action call site
 * still rendered in the activity-feed pre-Phase-10. Redirects to the
 * canonical soft-delete path.
 */
export async function deleteActivityAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "activity.archive" }, async () => {
    const user = await requireSession();
    const activityId = z.string().uuid().parse(formData.get("activityId"));
    const leadId = z.string().uuid().parse(formData.get("leadId"));
    await requireLeadAccess(user, leadId);

    const [row] = await db
      .select({ id: activities.id, userId: activities.userId })
      .from(activities)
      .where(eq(activities.id, activityId))
      .limit(1);
    if (!row) throw new ForbiddenError("Activity not found.");
    if (!canDeleteActivity(user, row)) {
      throw new ForbiddenError("You can't archive this activity.");
    }
    await softDeleteActivity(activityId, user.id, user.isAdmin);
    await writeAudit({
      actorId: user.id,
      action: "activity.archive",
      targetType: "activity",
      targetId: activityId,
    });
    revalidatePath(`/leads/${leadId}`);
  });
}

