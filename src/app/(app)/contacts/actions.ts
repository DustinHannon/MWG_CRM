"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema/crm-records";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveContactsById,
  deleteContactsById,
  restoreContactsById,
  updateContactForApi,
} from "@/lib/contacts";
import { canDeleteContact, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";

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
    await deleteContactsById([id]);
    await writeAudit({
      actorId: user.id,
      action: "contact.hard_delete",
      targetType: "contact",
      targetId: id,
      before: (snapshot ?? null) as object | null,
    });
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
  description: z.string().trim().max(4000).optional().nullable(),
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
      const [existing] = await db
        .select({
          id: contacts.id,
          ownerId: contacts.ownerId,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          jobTitle: contacts.jobTitle,
          email: contacts.email,
          phone: contacts.phone,
          description: contacts.description,
        })
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
          description: parsed.description ?? null,
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
