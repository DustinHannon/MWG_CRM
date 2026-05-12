"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { crmAccounts } from "@/db/schema/crm-records";
import { requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";
import {
  archiveAccountsById,
  deleteAccountsById,
  restoreAccountsById,
  updateAccountForApi,
} from "@/lib/accounts";
import { canDeleteAccount, canHardDelete } from "@/lib/access/can-delete";
import { signUndoToken, verifyUndoToken } from "@/lib/actions/soft-delete";

/**
 * soft-delete an account. Owner OR admin.
 */
export async function softDeleteAccountAction(input: {
  id: string;
  reason?: string;
}): Promise<ActionResult<{ undoToken: string }>> {
  return withErrorBoundary(
    { action: "account.archive", entityType: "account", entityId: input.id },
    async () => {
      const user = await requireSession();
      const id = z.string().uuid().parse(input.id);
      const reason = input.reason?.trim() || undefined;

      const [row] = await db
        .select({ id: crmAccounts.id, ownerId: crmAccounts.ownerId, name: crmAccounts.name })
        .from(crmAccounts)
        .where(eq(crmAccounts.id, id))
        .limit(1);
      if (!row) throw new ForbiddenError("Account not found.");
      if (!canDeleteAccount(user, row)) {
        await writeAudit({
          actorId: user.id,
          action: "access.denied.account.delete",
          targetType: "account",
          targetId: id,
        });
        throw new ForbiddenError("You can't archive this account.");
      }

      await archiveAccountsById([id], user.id, reason);
      await writeAudit({
        actorId: user.id,
        action: "account.archive",
        targetType: "account",
        targetId: id,
        before: { name: row.name, ownerId: row.ownerId },
        after: { reason: reason ?? null },
      });

      revalidatePath("/accounts");
      revalidatePath(`/accounts/${id}`);
      return {
        undoToken: signUndoToken({ entity: "account", id, deletedAt: new Date() }),
      };
    },
  );
}

export async function undoArchiveAccountAction(input: {
  undoToken: string;
}): Promise<ActionResult> {
  return withErrorBoundary({ action: "account.unarchive_undo" }, async () => {
    const user = await requireSession();
    const payload = verifyUndoToken(input.undoToken);
    if (payload.entity !== "account") throw new ForbiddenError("Token mismatch.");
    const [row] = await db
      .select({ id: crmAccounts.id, ownerId: crmAccounts.ownerId })
      .from(crmAccounts)
      .where(eq(crmAccounts.id, payload.id))
      .limit(1);
    // BUG-003: row may have been hard-deleted by an admin
    // between the soft-delete and the user clicking Undo. Surface a
    // clear NotFound rather than a misleading Forbidden so the toast
    // can show "This record was permanently deleted" without the user
    // thinking they hit a permission wall.
    if (!row) {
      throw new NotFoundError(
        "account — it was permanently deleted before Undo could run",
      );
    }
    if (!canDeleteAccount(user, row)) throw new ForbiddenError("You can't restore this account.");
    await restoreAccountsById([payload.id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "account.unarchive_undo",
      targetType: "account",
      targetId: payload.id,
    });
    revalidatePath("/accounts");
    revalidatePath("/accounts/archived");
  });
}

/**
 * admin restore from archive view.
 */
export async function restoreAccountAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "account.restore" }, async () => {
    const user = await requireSession();
    if (!canHardDelete(user)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    await restoreAccountsById([id], user.id);
    await writeAudit({
      actorId: user.id,
      action: "account.restore",
      targetType: "account",
      targetId: id,
    });
    revalidatePath("/accounts/archived");
    revalidatePath("/accounts");
  });
}

/**
 * admin hard delete from archive view.
 */
export async function hardDeleteAccountAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "account.hard_delete" }, async () => {
    const user = await requireSession();
    if (!canHardDelete(user)) throw new ForbiddenError("Admin only.");
    const id = z.string().uuid().parse(formData.get("id"));
    const [snapshot] = await db
      .select()
      .from(crmAccounts)
      .where(eq(crmAccounts.id, id))
      .limit(1);
    await deleteAccountsById([id]);
    await writeAudit({
      actorId: user.id,
      action: "account.hard_delete",
      targetType: "account",
      targetId: id,
      before: (snapshot ?? null) as object | null,
    });
    revalidatePath("/accounts/archived");
  });
}

/**
 * dedicated edit form for accounts. Thin wrapper
 * around `updateAccountForApi`; OCC enforced via expectedVersion in
 * the form (hidden field).
 */
const accountUpdateSchema = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(120).optional().nullable(),
  website: z.string().trim().max(200).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
});

export async function updateAccountAction(
  fd: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "account.update", entityType: "account" },
    async () => {
      const user = await requireSession();
      const parsed = accountUpdateSchema.parse(
        Object.fromEntries(fd.entries()),
      );
      // Access gate: load + verify the user owns or has admin/canViewAll.
      const [existing] = await db
        .select({
          id: crmAccounts.id,
          ownerId: crmAccounts.ownerId,
          name: crmAccounts.name,
          industry: crmAccounts.industry,
          website: crmAccounts.website,
          phone: crmAccounts.phone,
          description: crmAccounts.description,
        })
        .from(crmAccounts)
        .where(eq(crmAccounts.id, parsed.id))
        .limit(1);
      if (!existing) throw new NotFoundError("account");
      if (!user.isAdmin && existing.ownerId !== user.id) {
        throw new ForbiddenError(
          "You don't have permission to edit this account.",
        );
      }

      await updateAccountForApi(
        parsed.id,
        {
          name: parsed.name,
          industry: parsed.industry ?? null,
          website: parsed.website ?? null,
          phone: parsed.phone ?? null,
          description: parsed.description ?? null,
        },
        parsed.version,
        user.id,
      );

      await writeAudit({
        actorId: user.id,
        action: "account.update",
        targetType: "account",
        targetId: parsed.id,
        before: existing as object,
        after: parsed as object,
      });

      revalidatePath(`/accounts/${parsed.id}`);
      revalidatePath("/accounts");
    },
  );
}
