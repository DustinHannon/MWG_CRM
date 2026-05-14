"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  getPermissions,
  requireLeadAccess,
  requireLeadEditAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import {
  createLead,
  archiveLeadsById,
  deleteLeadsById,
  restoreLeadsById,
  leadCreateSchema,
  leadPartialSchema,
  updateLead,
} from "@/lib/leads";
import { setLeadTags } from "@/lib/tags";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { tags as tagsTable } from "@/db/schema/tags";
import { gatherBlobsForLeads } from "@/lib/blob-cleanup";
import { enqueueJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import { canDeleteLead } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (k === "id") continue;
    // `tagIds` (combobox) and the legacy
    // `tags` key are extracted separately by parseTagIds; skip them
    // here so they don't reach the leadCreate / leadPartial schema.
    if (k === "tagIds" || k === "tags") continue;
    if (v === "") continue;
    if (k === "doNotContact" || k === "doNotEmail" || k === "doNotCall") {
      obj[k] = v === "on" || v === "true";
      continue;
    }
    obj[k] = v;
  }
  return obj;
}

/**
 * TagInput emits a single hidden input
 * `tagIds` whose value is a comma-separated list of tag UUIDs (the
 * tags themselves were either already-selected or just created via
 * getOrCreateTagAction with tagName validation from Wave 7). Parse
 * defensively: drop blanks, trim, validate UUID shape, and dedupe.
 */
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function parseTagIds(formData: FormData): string[] {
  const raw = formData.get("tagIds");
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && uuidPattern.test(s));
  return Array.from(new Set(ids));
}

export async function createLeadAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "lead.create" },
    async () => {
      const user = await requireSession();
      const perms = await getPermissions(user.id);
      if (!user.isAdmin && !perms.canCreateLeads) {
        throw new ForbiddenError("You don't have permission to create leads.");
      }

      const parsed = leadCreateSchema.safeParse(formToObject(formData));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Validation failed.",
        );
      }

      const { id } = await createLead(user, parsed.data);
      // persist tag selections from the
      // combobox into the relational lead_tags table. setLeadTags is
      // idempotent (full-replace inside a tx); empty list is a no-op.
      // Gate on canApplyTags so users without the tag-apply perm
      // cannot back-door tag application via the create-lead form.
      // Admin bypasses requirePermission.
      const tagIds = parseTagIds(formData);
      if (tagIds.length > 0) {
        if (!user.isAdmin && !perms.canApplyTags) {
          throw new ForbiddenError(
            "You don't have permission to apply tags.",
          );
        }
        await setLeadTags(id, tagIds, user.id);
        // Per-tag audit emission so the create-with-tags path matches
        // the inline applyTagAction forensic surface. Without this,
        // creating a lead with 5 tags would write only the lead.create
        // audit row while inline-applying 5 tags writes 5 tag.applied
        // rows. Inconsistent forensics confuse downstream audit queries.
        // writeAuditBatch consolidates the N per-tag rows into a
        // single INSERT.
        const tagRows = await db
          .select({ id: tagsTable.id, name: tagsTable.name })
          .from(tagsTable)
          .where(inArray(tagsTable.id, tagIds));
        await writeAuditBatch({
          actorId: user.id,
          events: tagRows.map((t) => ({
            action: "tag.applied",
            targetType: "lead",
            targetId: id,
            after: {
              entityType: "lead" as const,
              entityId: id,
              tagId: t.id,
              tagName: t.name,
              source: "lead.create",
            },
          })),
        });
      }
      await writeAudit({
        actorId: user.id,
        action: "lead.create",
        targetType: "lead",
        targetId: id,
        after: { firstName: parsed.data.firstName, lastName: parsed.data.lastName },
      });

      revalidatePath("/leads");
      redirect(`/leads/${id}`);
    },
  );
}

export async function updateLeadAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "lead.update" },
    async () => {
      const user = await requireSession();

      const id = z.string().uuid().parse(formData.get("id"));
      // version travels through the form as a hidden input. The
      // server action requires it so concurrentUpdate can refuse stale writes.
      const version = z.coerce
        .number()
        .int()
        .positive()
        .parse(formData.get("version"));

      // Verify edit permission AND access to this specific lead. Closes
      // horizontal priv-esc where a forged form could submit another user's
      // lead id.
      await requireLeadEditAccess(user, id);

      const parsed = leadPartialSchema.safeParse(formToObject(formData));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new ValidationError(
          first
            ? `${first.path.join(".") || "input"}: ${first.message}`
            : "Validation failed.",
        );
      }

      const before = await db
        .select({
          firstName: leads.firstName,
          lastName: leads.lastName,
          status: leads.status,
        })
        .from(leads)
        .where(eq(leads.id, id))
        .limit(1);

      await updateLead(user, id, version, parsed.data);

      // Tag changes flow through the inline applyTagAction /
      // removeTagAction actions on the edit page (TagSectionClient),
      // not through the lead-form payload. No tag handling here.

      await writeAudit({
        actorId: user.id,
        action: "lead.update",
        targetType: "lead",
        targetId: id,
        before: before[0] ?? null,
        after: parsed.data,
      });

      revalidatePath("/leads");
      revalidatePath(`/leads/${id}`);
      redirect(`/leads/${id}`);
    },
  );
}

/**
 * what was "delete" is now "archive". Sets `is_deleted=true`;
 * the row is preserved for 30 days, then `cron/purge-archived` hard-deletes.
 * Admins can hard-delete from /leads/archived.
 *
 * kept for backwards compatibility on the existing detail-page
 * form action. New callers should prefer `softDeleteLeadAction`.
 *
 * @actor signed-in user with delete permission and lead access
 */
export async function deleteLeadAction(
  formData: FormData,
): Promise<ActionResult<never>> {
  return withErrorBoundary(
    { action: "lead.archive" },
    async () => {
      const user = await requireSession();
      const perms = await getPermissions(user.id);
      if (!user.isAdmin && !perms.canDeleteLeads) {
        throw new ForbiddenError("You don't have permission to delete leads.");
      }
      const id = z.string().uuid().parse(formData.get("id"));
      await requireLeadAccess(user, id);
      const reason =
        (formData.get("reason") as string | null)?.trim() || undefined;
      await archiveLeadsById([id], user.id, reason);
      await writeAudit({
        actorId: user.id,
        action: "lead.archive",
        targetType: "lead",
        targetId: id,
        after: { reason: reason ?? null },
      });
      revalidatePath("/leads");
      redirect("/leads");
    },
  );
}

/**
 * JSON-input variant for the new client UI. Returns an
 * `undoToken` that the toast Undo button can replay. Permission gate
 * is strict ownership-or-admin per the matrix.
 *
 * @actor lead owner or admin
 */
export async function softDeleteLeadAction(input: {
  id: string;
  reason?: string;
}): Promise<ActionResult<{ undoToken: string }>> {
  return withErrorBoundary(
    { action: "lead.archive", entityType: "lead", entityId: input.id },
    async () => {
      const user = await requireSession();
      const id = z.string().uuid().parse(input.id);
      const reason = input.reason?.trim() || undefined;

      // Re-fetch — never trust the client's claim of ownership.
      const [row] = await db
        .select({ id: leads.id, ownerId: leads.ownerId, firstName: leads.firstName, lastName: leads.lastName })
        .from(leads)
        .where(eq(leads.id, id))
        .limit(1);
      if (!row) throw new ForbiddenError("Lead not found.");
      if (!canDeleteLead(user, row)) {
        await writeAudit({
          actorId: user.id,
          action: "access.denied.lead.delete",
          targetType: "lead",
          targetId: id,
        });
        throw new ForbiddenError("You can't archive this lead.");
      }

      await archiveLeadsById([id], user.id, reason);
      await writeAudit({
        actorId: user.id,
        action: "lead.archive",
        targetType: "lead",
        targetId: id,
        before: { firstName: row.firstName, lastName: row.lastName, ownerId: row.ownerId },
        after: { reason: reason ?? null },
      });

      const undoToken = signUndoToken({
        entity: "lead",
        id,
        deletedAt: new Date(),
      });

      revalidatePath("/leads");
      revalidatePath(`/leads/${id}`);
      return { undoToken };
    },
  );
}

/**
 * toast-Undo replay. Re-checks the HMAC, then restores. Same
 * ownership/admin check applies (the user must still be allowed to act
 * on this lead, even if 2 seconds ago they were).
 *
 * @actor original archiver, owner, or admin
 */
export async function undoArchiveLeadAction(input: {
  undoToken: string;
}): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "lead.unarchive_undo" },
    async () => {
      const user = await requireSession();
      const payload = verifyUndoToken(input.undoToken);
      if (payload.entity !== "lead") {
        throw new ForbiddenError("Token mismatch.");
      }
      const [row] = await db
        .select({ id: leads.id, ownerId: leads.ownerId })
        .from(leads)
        .where(eq(leads.id, payload.id))
        .limit(1);
      // BUG-003: row may have been hard-deleted by an admin
      // between soft-delete and Undo. Surface a clear NotFound.
      if (!row) {
        throw new NotFoundError(
          "lead — it was permanently deleted before Undo could run",
        );
      }
      if (!canDeleteLead(user, row)) {
        throw new ForbiddenError("You can't restore this lead.");
      }
      await restoreLeadsById([payload.id], user.id);
      await writeAudit({
        actorId: user.id,
        action: "lead.unarchive_undo",
        targetType: "lead",
        targetId: payload.id,
      });
      revalidatePath("/leads");
      revalidatePath("/leads/archived");
    },
  );
}

/**
 * admin-only restore from the archive view.
 *
 * @actor admin
 */
export async function restoreLeadAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "lead.restore" },
    async () => {
      const user = await requireSession();
      if (!user.isAdmin) throw new ForbiddenError("Admin only.");
      const id = z.string().uuid().parse(formData.get("id"));
      await restoreLeadsById([id], user.id);
      await writeAudit({
        actorId: user.id,
        action: "lead.restore",
        targetType: "lead",
        targetId: id,
      });
      revalidatePath("/leads/archived");
      revalidatePath("/leads");
    },
  );
}

/**
 * admin-only hard delete from the archive view.
 * Cascades through children. Vercel Blob cleanup now runs
 * fire-and-forget after the DB delete commits (Audit E F-024).
 *
 * @actor admin
 */
export async function hardDeleteLeadAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "lead.hard_delete" },
    async () => {
      const user = await requireSession();
      if (!user.isAdmin) throw new ForbiddenError("Admin only.");
      const id = z.string().uuid().parse(formData.get("id"));
      // 024 — collect attachment blob pathnames BEFORE the DB
      // delete; after CASCADE the join rows are gone and the blobs are
      // unrecoverable. Failure to gather is non-fatal.
      let blobPathnames: string[] = [];
      try {
        blobPathnames = await gatherBlobsForLeads([id]);
      } catch (err) {
        logger.error("blob_cleanup_gather_failure_hard_delete", {
          leadId: id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      await deleteLeadsById([id]);
      await writeAudit({
        actorId: user.id,
        action: "lead.hard_delete",
        targetType: "lead",
        targetId: id,
      });
      // Durable async cleanup via the job queue (F-Ω-8). The previous
      // `void deleteBlobsByPathnames(...).catch(...)` pattern was not
      // durable — STANDARDS §19.11.3 flagged lambda termination as a
      // loss vector. The enqueue commits a row in `job_queue`; the
      // worker cron claims it, calls `del()`, and persists success or
      // retries with backoff. Skip the enqueue when the path list is
      // empty (no point storing a no-op job).
      if (blobPathnames.length > 0) {
        try {
          await enqueueJob(
            "blob-cleanup",
            {
              pathnames: blobPathnames,
              origin: { entityType: "lead", entityId: id },
            },
            {
              actorId: user.id,
              metadata: {
                originAction: "lead.hard_delete",
                leadId: id,
                blobCount: blobPathnames.length,
              },
            },
          );
        } catch (err) {
          // Enqueue failure is logged but does not roll back the DB
          // hard-delete. The blobs become orphans in this rare path
          // (DB write success + queue write failure) — same risk
          // profile as a queue-side outage during retry. The DB record
          // remains the source of truth.
          logger.error("blob_cleanup_enqueue_failure_hard_delete", {
            leadId: id,
            blobCount: blobPathnames.length,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }
      revalidatePath("/leads/archived");
    },
  );
}
