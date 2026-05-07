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
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
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
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema/leads";
import { cleanupBlobsForLeads, gatherBlobsForLeads } from "@/lib/blob-cleanup";
import { logger } from "@/lib/logger";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) {
    if (k === "id") continue;
    // Phase 8D Wave 6 (FIX-016) — `tagIds` (combobox) and the legacy
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
 * Phase 8D Wave 6 (FIX-016) — TagInput emits a single hidden input
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
      // Phase 8D Wave 6 (FIX-016) — persist tag selections from the
      // combobox into the relational lead_tags table. setLeadTags is
      // idempotent (full-replace inside a tx); empty list is a no-op.
      const tagIds = parseTagIds(formData);
      if (tagIds.length > 0) {
        await setLeadTags(id, tagIds, user.id);
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
      // Phase 6B — version travels through the form as a hidden input. The
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

      // Phase 8D Wave 6 (FIX-016) — sync tag selections from the
      // combobox. setLeadTags is full-replace, so removing all chips
      // and submitting clears the lead's tags. The hidden tagIds input
      // is always present in the form (even when empty) so we can
      // distinguish "no tags" from "field not on form".
      const tagIds = parseTagIds(formData);
      await setLeadTags(id, tagIds, user.id);

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
 * Phase 4G — what was "delete" is now "archive". Sets `is_deleted=true`;
 * the row is preserved for 30 days, then `cron/purge-archived` hard-deletes.
 * Admins can hard-delete from /leads/archived.
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
 * Phase 4G — admin-only restore from the archive view.
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
 * Phase 4G — admin-only hard delete from the archive view.
 * Cascades through children. Phase 8D — Vercel Blob cleanup now runs
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
      // Phase 8D F-024 — collect attachment blob pathnames BEFORE the DB
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
      // Phase 8D F-024 — fire-and-forget blob cleanup. cleanupBlobsForLeads
      // already swallows internal errors; this catch is belt-and-suspenders
      // for an unhandled throw that would otherwise unhandle-reject.
      if (blobPathnames.length > 0) {
        void cleanupBlobsForLeads([id]).catch((err) => {
          logger.error("blob_cleanup_failure_hard_delete", {
            leadId: id,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        });
      }
      revalidatePath("/leads/archived");
    },
  );
}
