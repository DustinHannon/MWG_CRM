"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema/crm-records";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveContactsById,
  deleteContactsById,
  restoreContactsById,
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
    if (!row) throw new ForbiddenError("Contact not found.");
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
