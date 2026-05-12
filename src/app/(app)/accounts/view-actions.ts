"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  ACCOUNT_COLUMN_KEYS,
  type AccountColumnKey,
} from "@/lib/account-view-constants";
import {
  accountViewSchema,
  createSavedAccountView,
  deleteSavedAccountView,
  setAccountAdhocColumns,
  setDefaultAccountView,
  updateSavedAccountView,
} from "@/lib/account-views";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

export interface AccountViewIdData {
  id: string;
}

/**
 * Save the current accounts filters/columns/sort as a new view.
 */
export async function createAccountViewAction(
  formData: FormData,
): Promise<ActionResult<AccountViewIdData>> {
  return withErrorBoundary(
    { action: "account.view.create" },
    async (): Promise<AccountViewIdData> => {
      const user = await requireSession();
      const raw = formData.get("payload");
      if (typeof raw !== "string") {
        throw new ValidationError("Missing payload.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ValidationError("Invalid payload JSON.");
      }
      const result = accountViewSchema.parse(parsed);

      try {
        const { id } = await createSavedAccountView(user.id, result);
        // Auto-revert adhoc on save: when the user crystalises the
        // current state into a new view, clear the originating
        // built-in view's adhoc column choice so switching back
        // shows clean defaults.
        await setAccountAdhocColumns(user.id, null);
        await writeAudit({
          actorId: user.id,
          action: "account.view.create",
          targetType: "saved_view",
          targetId: id,
          after: { name: result.name, page: "account", adhocReverted: true },
        });
        revalidatePath("/accounts");
        return { id };
      } catch (err) {
        if (err instanceof Error && err.message.includes("unique")) {
          throw new ConflictError("A view with that name already exists.");
        }
        throw err;
      }
    },
  );
}

/**
 * Update an existing saved account view.
 */
export async function updateAccountViewAction(
  formData: FormData,
): Promise<ActionResult<AccountViewIdData>> {
  return withErrorBoundary(
    { action: "account.view.update" },
    async (): Promise<AccountViewIdData> => {
      const user = await requireSession();
      const id = z.string().uuid().parse(formData.get("id"));
      const version = z.coerce
        .number()
        .int()
        .positive()
        .parse(formData.get("version"));
      const raw = formData.get("payload");
      if (typeof raw !== "string") throw new ValidationError("Missing payload.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ValidationError("Invalid payload JSON.");
      }
      const result = accountViewSchema.partial().parse(parsed);

      await updateSavedAccountView(user.id, id, version, result);

      await writeAudit({
        actorId: user.id,
        action: "account.view.update",
        targetType: "saved_view",
        targetId: id,
        after: { page: "account" },
      });
      revalidatePath("/accounts");
      return { id };
    },
  );
}

export async function deleteAccountViewAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "account.view.delete" }, async () => {
    const user = await requireSession();
    const id = z.string().uuid().parse(formData.get("id"));
    await deleteSavedAccountView(user.id, id);
    await writeAudit({
      actorId: user.id,
      action: "account.view.delete",
      targetType: "saved_view",
      targetId: id,
      after: { page: "account" },
    });
    revalidatePath("/accounts");
  });
}

const setDefaultSchema = z.object({
  viewId: z.string().nullable(),
});

export async function setDefaultAccountViewAction(
  payload: z.infer<typeof setDefaultSchema>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "account.view.set_default" },
    async () => {
      const user = await requireSession();
      const parsed = setDefaultSchema.parse(payload);
      await setDefaultAccountView(user.id, parsed.viewId);
      await writeAudit({
        actorId: user.id,
        action: "account.view.set_default",
        targetType: "saved_view",
        targetId: parsed.viewId?.startsWith("saved:")
          ? parsed.viewId.slice("saved:".length)
          : (parsed.viewId ?? "none"),
        after: { page: "account", viewId: parsed.viewId },
      });
      revalidatePath("/accounts");
    },
  );
}

const adhocSchema = z.object({
  columns: z
    .array(
      z.enum(
        ACCOUNT_COLUMN_KEYS as [AccountColumnKey, ...AccountColumnKey[]],
      ),
    )
    .nullable(),
});

export async function setAccountAdhocColumnsAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "account.view.set_adhoc_columns" },
    async () => {
      const user = await requireSession();
      const raw = formData.get("payload");
      if (typeof raw !== "string")
        throw new ValidationError("Missing payload.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ValidationError("Invalid payload JSON.");
      }
      const result = adhocSchema.parse(parsed);
      await setAccountAdhocColumns(user.id, result.columns);
    },
  );
}

/**
 * reset the current accounts view to its saved definition.
 *
 * The client owns the URL navigation; this action handles the
 * server-side side-effects: clear adhoc columns when the active view
 * is a built-in, and emit the audit event so the reset is forensically
 * traceable.
 */
const resetSchema = z.object({
  viewId: z.string(),
  viewName: z.string(),
  modifiedFields: z.array(z.string()),
});

export async function resetAccountViewAction(
  payload: z.infer<typeof resetSchema>,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "view.reset_to_saved" }, async () => {
    const user = await requireSession();
    const parsed = resetSchema.parse(payload);
    if (parsed.viewId.startsWith("builtin:")) {
      await setAccountAdhocColumns(user.id, null);
    }
    await writeAudit({
      actorId: user.id,
      action: "view.reset_to_saved",
      targetType: "saved_view",
      targetId: parsed.viewId.startsWith("saved:")
        ? parsed.viewId.slice("saved:".length)
        : parsed.viewId,
      after: {
        page: "account",
        viewName: parsed.viewName,
        modifiedFields: parsed.modifiedFields,
      },
    });
  });
}
