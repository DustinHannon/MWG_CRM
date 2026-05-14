"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema/crm-records";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveContactsById,
  deleteContactsById,
  restoreContactsById,
  updateContactForApi,
} from "@/lib/contacts";
import { canDeleteContact, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";
import { gatherBlobsForActivityParent } from "@/lib/blob-cleanup";
import { enqueueJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";

export async function softDeleteContactAction(input: {
  id: string;
  reason?: string;
}): Promise<ActionResult<{ undoToken: string }>> {
  return withErrorBoundary(
    { action: "contact.archive", entityType: "contact", entityId: input.id },
    async () => {
      const user = await requireSession();
      const id = z.string().uuid().parse(input.id);
      const reason = input.reason?.trim() || undefined;

      const [row] = await db
        .select({
          id: contacts.id,
          ownerId: contacts.ownerId,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
        })
        .from(contacts)
        .where(eq(contacts.id, id))
        .limit(1);
      if (!row) throw new ForbiddenError("Contact not found.");
      if (!canDeleteContact(user, row)) {
        await writeAudit({
          actorId: user.id,
          action: "access.denied.contact.delete",
          targetType: "contact",
          targetId: id,
        });
        throw new ForbiddenError("You can't archive this contact.");
      }

      await archiveContactsById([id], user.id, reason);
      await writeAudit({
        actorId: user.id,
        action: "contact.archive",
        targetType: "contact",
        targetId: id,
        before: { firstName: row.firstName, lastName: row.lastName, ownerId: row.ownerId },
        after: { reason: reason ?? null },
      });

      revalidatePath("/contacts");
      revalidatePath(`/contacts/${id}`);
      return {
        undoToken: signUndoToken({ entity: "contact", id, deletedAt: new Date() }),
      };
    },
  );
}

export async function undoArchiveContactAction(input: {
  undoToken: string;
}): Promise<ActionResult> {
  return withErrorBoundary({ action: "contact.unarchive_undo" }, async () => {
    const user = await requireSession();
    const payload = verifyUndoToken(input.undoToken);
    if (payload.entity !== "contact") throw new ForbiddenError("Token mismatch.");
    const [row] = await db
      .select({ id: contacts.id, ownerId: contacts.ownerId })
      .from(contacts)
      .where(eq(contacts.id, payload.id))
      .limit(1);
    // BUG-003: row may have been hard-deleted by an admin
    // between soft-delete and Undo. Surface a clear NotFound.
    if (!row) {
      throw new NotFoundError(
        "contact — it was permanently deleted before Undo could run",
      );
    }
    if (!canDeleteContact(user, row)) throw new ForbiddenError("You can't restore this contact.");
    await restoreContactsById([payload.id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "contact.unarchive_undo",
      targetType: "contact",
      targetId: payload.id,
    });
    revalidatePath("/contacts");
    revalidatePath("/contacts/archived");
  });
}

export async function restoreContactAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "contact.restore" }, async () => {
    const user = await requireSession();
    if (!canHardDelete(user)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    await restoreContactsById([id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "contact.restore",
      targetType: "contact",
      targetId: id,
    });
    revalidatePath("/contacts/archived");
    revalidatePath("/contacts");
  });
}

export async function hardDeleteContactAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "contact.hard_delete" }, async () => {
    const user = await requireSession();
    if (!canHardDelete(user)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    const [snapshot] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1);
    // Collect attachment blob pathnames BEFORE the DB delete; after
    // CASCADE the activities -> attachments join rows are gone and the
    // blobs are unrecoverable. Failure to gather is non-fatal.
    let blobPathnames: string[] = [];
    try {
      blobPathnames = await gatherBlobsForActivityParent("contact", [id]);
    } catch (err) {
      logger.error("blob_cleanup_gather_failure_hard_delete", {
        entity: "contact",
        entityId: id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    await deleteContactsById([id]);
    await writeAudit({
      actorId: user.id,
      action: "contact.hard_delete",
      targetType: "contact",
      targetId: id,
      before: (snapshot ?? null) as object | null,
    });
    // Durable async cleanup via the job queue (F-Ω-8). See the lead
    // hard-delete action for the rationale — STANDARDS §19.11.3.
    if (blobPathnames.length > 0) {
      try {
        await enqueueJob(
          "blob-cleanup",
          {
            pathnames: blobPathnames,
            origin: { entityType: "contact", entityId: id },
          },
          {
            actorId: user.id,
            metadata: {
              originAction: "contact.hard_delete",
              entityId: id,
              blobCount: blobPathnames.length,
            },
          },
        );
      } catch (err) {
        logger.error("blob_cleanup_enqueue_failure_hard_delete", {
          entity: "contact",
          entityId: id,
          blobCount: blobPathnames.length,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    revalidatePath("/contacts/archived");
  });
}

/**
 * dedicated edit form for contacts. Thin wrapper
 * around `updateContactForApi`; OCC via expectedVersion.
 */
const contactUpdateSchema = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).optional().nullable(),
  jobTitle: z.string().trim().max(120).optional().nullable(),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  phone: z.string().trim().max(40).optional().nullable(),
  mobilePhone: z.string().trim().max(40).optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
  // Address
  street1: z.string().trim().max(200).optional().nullable(),
  street2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(80).optional().nullable(),
  birthdate: z
    .string()
    .trim()
    .max(10)
    .optional()
    .nullable()
    .transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/u.test(v) ? v : null)),
  // Preferences (checkboxes submit "on" or absent)
  doNotEmail: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal("")])
    .optional()
    .transform((v) => v === "on" || v === "true"),
  doNotCall: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal("")])
    .optional()
    .transform((v) => v === "on" || v === "true"),
  doNotMail: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal("")])
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

export async function updateContactAction(
  fd: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "contact.update", entityType: "contact" },
    async () => {
      const user = await requireSession();
      const parsed = contactUpdateSchema.parse(
        Object.fromEntries(fd.entries()),
      );
      // Full-row snapshot for audit `before` — captures every column
      // that the update action may modify, so the audit trail shows
      // the complete pre-change state including new D365-parity fields.
      const [existing] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, parsed.id))
        .limit(1);
      if (!existing) throw new NotFoundError("contact");
      if (!user.isAdmin && existing.ownerId !== user.id) {
        throw new ForbiddenError(
          "You don't have permission to edit this contact.",
        );
      }

      await updateContactForApi(
        parsed.id,
        {
          firstName: parsed.firstName,
          lastName: parsed.lastName ?? null,
          jobTitle: parsed.jobTitle ?? null,
          email: parsed.email,
          phone: parsed.phone ?? null,
          mobilePhone: parsed.mobilePhone ?? null,
          description: parsed.description ?? null,
          street1: parsed.street1 ?? null,
          street2: parsed.street2 ?? null,
          city: parsed.city ?? null,
          state: parsed.state ?? null,
          postalCode: parsed.postalCode ?? null,
          country: parsed.country ?? null,
          birthdate: parsed.birthdate ?? null,
          doNotEmail: parsed.doNotEmail,
          doNotCall: parsed.doNotCall,
          doNotMail: parsed.doNotMail,
          doNotContact: parsed.doNotEmail && parsed.doNotCall,
        },
        parsed.version,
        user.id,
      );

      await writeAudit({
        actorId: user.id,
        action: "contact.update",
        targetType: "contact",
        targetId: parsed.id,
        before: existing as object,
        after: parsed as object,
      });

      revalidatePath(`/contacts/${parsed.id}`);
      revalidatePath("/contacts");
    },
  );
}

/**
 * bulk soft-delete from the /contacts list page toolbar.
 *
 * The caller passes the selected row ids; this action filters down to
 * those the actor is allowed to archive (own + admin) and applies the
 * archive in a single batch. Each archived id emits a per-row audit
 * event for forensic clarity. Forbidden ids surface in `denied` so
 * the UI can show a partial-success toast.
 */
const bulkArchiveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().max(500).optional(),
});

export async function bulkArchiveContactsAction(
  payload: z.infer<typeof bulkArchiveSchema>,
): Promise<
  ActionResult<{
    archived: number;
    denied: number;
  }>
> {
  return withErrorBoundary({ action: "contact.bulk_archive" }, async () => {
    const user = await requireSession();
    const parsed = bulkArchiveSchema.parse(payload);
    if (parsed.ids.length === 0) {
      throw new ValidationError("No contacts selected.");
    }
    const rows = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        ownerId: contacts.ownerId,
      })
      .from(contacts)
      .where(inArray(contacts.id, parsed.ids));
    const allowed: typeof rows = [];
    const denied: string[] = [];
    for (const row of rows) {
      if (canDeleteContact(user, row)) allowed.push(row);
      else denied.push(row.id);
    }
    if (allowed.length === 0) {
      throw new ForbiddenError("You can't archive any of these contacts.");
    }
    const reason = parsed.reason?.trim() || undefined;
    await archiveContactsById(
      allowed.map((r) => r.id),
      user.id,
      reason,
    );
    // Per-record audit rows via single-INSERT batch helper (see
    // src/lib/audit.ts writeAuditBatch). Same emitted event name
    // (contact.archive) per row.
    await writeAuditBatch({
      actorId: user.id,
      events: allowed.map((row) => ({
        action: "contact.archive",
        targetType: "contact",
        targetId: row.id,
        before: {
          firstName: row.firstName,
          lastName: row.lastName,
          ownerId: row.ownerId,
        },
        after: { reason: reason ?? null, bulk: true },
      })),
    });
    revalidatePath("/contacts");
    return { archived: allowed.length, denied: denied.length };
  });
}
