"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema/crm-records";
import { recentViews } from "@/db/schema/recent-views";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit, writeAuditBatch } from "@/lib/audit";
import {
  emitActivity,
  emitActivities,
  type EmitActivityInput,
} from "@/lib/notifications";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveContactsById,
  bulkArchiveContacts,
  deleteContactsById,
  restoreContactsById,
  updateContactForApi,
} from "@/lib/contacts";
import {
  bulkRowVersionsSchema,
  isCascadeMarker,
} from "@/lib/cascade-archive";
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
      if (reason && isCascadeMarker(reason)) {
        throw new ValidationError(
          "That delete reason is reserved by the system. Enter a different reason.",
        );
      }

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

      const cascade = await archiveContactsById([id], user.id, reason);
      await writeAudit({
        actorId: user.id,
        action: "contact.archive",
        targetType: "contact",
        targetId: id,
        before: { firstName: row.firstName, lastName: row.lastName, ownerId: row.ownerId },
        after: {
          reason: reason ?? null,
          cascadedTasks: cascade.cascadedTasks,
          cascadedActivities: cascade.cascadedActivities,
        },
      });

      await emitActivity({
        actorId: user.id,
        verb: "Archived",
        entityType: "contact",
        entityId: id,
        entityDisplayName: `${row.firstName} ${row.lastName ?? ""}`.trim(),
        link: `/contacts/${id}`,
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
      .select({
        id: contacts.id,
        ownerId: contacts.ownerId,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      })
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
    const undoCascade = await restoreContactsById([payload.id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "contact.unarchive_undo",
      targetType: "contact",
      targetId: payload.id,
      after: {
        cascadedTasks: undoCascade.cascadedTasks,
        cascadedActivities: undoCascade.cascadedActivities,
      },
    });

    await emitActivity({
      actorId: user.id,
      verb: "Restored",
      entityType: "contact",
      entityId: payload.id,
      entityDisplayName: `${row.firstName} ${row.lastName ?? ""}`.trim(),
      link: `/contacts/${payload.id}`,
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
    const cascade = await restoreContactsById([id], user.id);
    const [restored] = await db
      .select({
        firstName: contacts.firstName,
        lastName: contacts.lastName,
      })
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1);
    await writeAudit({
      actorId: user.id,
      action: "contact.restore",
      targetType: "contact",
      targetId: id,
      after: {
        cascadedTasks: cascade.cascadedTasks,
        cascadedActivities: cascade.cascadedActivities,
      },
    });

    await emitActivity({
      actorId: user.id,
      verb: "Restored",
      entityType: "contact",
      entityId: id,
      entityDisplayName: `${restored?.firstName ?? ""} ${
        restored?.lastName ?? ""
      }`.trim(),
      link: `/contacts/${id}`,
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
    // recent_views has no polymorphic FK (free-text entity_type), so
    // hard-deleting the contact does NOT cascade its Cmd+K recent-view
    // rows — purge them explicitly. Best-effort: a failure here must
    // never roll back or block the hard delete. Mirrors the
    // blob-cleanup enqueue placement.
    try {
      await db
        .delete(recentViews)
        .where(
          and(
            eq(recentViews.entityType, "contact"),
            eq(recentViews.entityId, id),
          ),
        );
    } catch (err) {
      logger.error("recent_views.cleanup_failed", {
        entityType: "contact",
        ids: [id],
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
            idempotencyKey: `blob-cleanup:contact:${id}`,
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

      await emitActivity({
        actorId: user.id,
        verb: "Updated",
        entityType: "contact",
        entityId: parsed.id,
        entityDisplayName: `${parsed.firstName ?? existing.firstName ?? ""} ${
          parsed.lastName ?? existing.lastName ?? ""
        }`.trim(),
        link: `/contacts/${parsed.id}`,
      });

      revalidatePath(`/contacts/${parsed.id}`);
      revalidatePath("/contacts");
    },
  );
}

/**
 * bulk soft-delete from the /contacts list page toolbar.
 *
 * The caller passes the selected rows as `{ id, version }` pairs. The
 * action filters down to rows the actor may archive (own + admin) —
 * forbidden ids surface in `denied` for a partial-success toast — then
 * applies an OCC bulk archive: a row whose `version` was moved by
 * another writer is skipped and reported in `conflicts` (no silent
 * lost update — single-row contact edits enforce OCC, so bulk must
 * too). Each archived id emits a per-row `contact.archive` audit event
 * after the transaction for forensic clarity. The shared row-version
 * schema lives in `@/lib/cascade-archive` (same contract as bulk
 * account archive / task complete/reassign/delete). An optional
 * free-text reason is recorded on the archived row(s); it must not
 * collide with the reserved `__cascade__:` sentinel namespace.
 */
const bulkArchiveSchema = bulkRowVersionsSchema.extend({
  reason: z.string().max(500).optional(),
});

export async function bulkArchiveContactsAction(
  payload: z.infer<typeof bulkArchiveSchema>,
): Promise<
  ActionResult<{
    archived: number;
    denied: number;
    conflicts: string[];
  }>
> {
  return withErrorBoundary({ action: "contact.bulk_archive" }, async () => {
    const user = await requireSession();
    const parsed = bulkArchiveSchema.parse(payload);
    if (parsed.items.length === 0) {
      throw new ValidationError("No contacts selected.");
    }
    const reason = parsed.reason?.trim() || undefined;
    if (reason && isCascadeMarker(reason)) {
      throw new ValidationError(
        "That delete reason is reserved by the system. Enter a different reason.",
      );
    }
    // Per-record permission gate FIRST: only rows the actor may
    // archive (own + admin) reach the OCC mutation. Forbidden rows
    // surface in `denied` for a partial-success toast.
    const rows = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        ownerId: contacts.ownerId,
      })
      .from(contacts)
      .where(
        inArray(
          contacts.id,
          parsed.items.map((i) => i.id),
        ),
      );
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const allowedItems: { id: string; version: number }[] = [];
    const denied: string[] = [];
    for (const item of parsed.items) {
      const row = rowById.get(item.id);
      if (row && canDeleteContact(user, row)) {
        allowedItems.push({ id: item.id, version: item.version });
      } else {
        denied.push(item.id);
      }
    }
    if (allowedItems.length === 0) {
      throw new ForbiddenError("You can't archive any of these contacts.");
    }
    // OCC bulk archive + child tasks/activities cascade, one
    // transaction (STANDARDS 19.1.1). Returns the ids actually
    // mutated plus the ids skipped because their version moved.
    const result = await bulkArchiveContacts(
      allowedItems,
      user.id,
      reason,
    );
    // Per-record audit rows via single-INSERT batch helper, emitted
    // AFTER the transaction (STANDARDS 19.1.2) and only for the ids
    // actually archived. Same emitted event name (contact.archive)
    // per row. The cascaded child counts are recorded on the parent
    // event's `after` (parent-event-only — no per-child audit, the
    // count is the forensic record of how many children cascaded).
    if (result.updated.length > 0) {
      await writeAuditBatch({
        actorId: user.id,
        events: result.updated.map((id) => {
          const row = rowById.get(id);
          return {
            action: "contact.archive",
            targetType: "contact",
            targetId: id,
            before: row
              ? {
                  firstName: row.firstName,
                  lastName: row.lastName,
                  ownerId: row.ownerId,
                }
              : undefined,
            after: {
              reason: reason ?? null,
              bulk: true,
              // Batch-scoped totals (this bulk op cascaded N children
              // across all archived contacts), not per-record — the
              // per-record key would falsely imply each contact owned
              // the whole count. Parent-event-only (no per-child
              // audit); the totals are the forensic record of the
              // cascade's reach (M-1).
              batchCascadedTasks: result.cascadedTasks,
              batchCascadedActivities: result.cascadedActivities,
            },
          };
        }),
      });
    }
    if (result.updated.length > 0) {
      await emitActivities(
        result.updated.map((id): EmitActivityInput => {
          const row = rowById.get(id);
          return {
            actorId: user.id,
            verb: "Archived",
            entityType: "contact",
            entityId: id,
            entityDisplayName: row
              ? `${row.firstName} ${row.lastName ?? ""}`.trim()
              : "",
            link: `/contacts/${id}`,
          };
        }),
      );
    }
    revalidatePath("/contacts");
    return {
      archived: result.updated.length,
      denied: denied.length,
      conflicts: result.conflicts,
    };
  });
}
