"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  CONTACT_COLUMN_KEYS,
  type ContactColumnKey,
} from "@/lib/contact-view-constants";
import {
  contactViewSchema,
  createSavedContactView,
  deleteSavedContactView,
  setContactAdhocColumns,
  setDefaultContactView,
  updateSavedContactView,
} from "@/lib/contact-views";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

export interface ContactViewIdData {
  id: string;
}

/**
 * Save the current contacts filters/columns/sort as a new view.
 */
export async function createContactViewAction(
  formData: FormData,
): Promise<ActionResult<ContactViewIdData>> {
  return withErrorBoundary(
    { action: "contact.view.create" },
    async (): Promise<ContactViewIdData> => {
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
      const result = contactViewSchema.parse(parsed);

      try {
        const { id } = await createSavedContactView(user.id, result);
        // Auto-revert adhoc on save: when the user crystalises the
        // current state into a new view, clear the originating
        // built-in view's adhoc column choice so switching back
        // shows clean defaults.
        await setContactAdhocColumns(user.id, null);
        await writeAudit({
          actorId: user.id,
          action: "contact.view.create",
          targetType: "saved_view",
          targetId: id,
          after: { name: result.name, page: "contact", adhocReverted: true },
        });
        revalidatePath("/contacts");
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
 * Update an existing saved contact view.
 */
export async function updateContactViewAction(
  formData: FormData,
): Promise<ActionResult<ContactViewIdData>> {
  return withErrorBoundary(
    { action: "contact.view.update" },
    async (): Promise<ContactViewIdData> => {
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
      const result = contactViewSchema.partial().parse(parsed);

      await updateSavedContactView(user.id, id, version, result);

      await writeAudit({
        actorId: user.id,
        action: "contact.view.update",
        targetType: "saved_view",
        targetId: id,
        after: { page: "contact" },
      });
      revalidatePath("/contacts");
      return { id };
    },
  );
}

export async function deleteContactViewAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "contact.view.delete" }, async () => {
    const user = await requireSession();
    const id = z.string().uuid().parse(formData.get("id"));
    await deleteSavedContactView(user.id, id);
    await writeAudit({
      actorId: user.id,
      action: "contact.view.delete",
      targetType: "saved_view",
      targetId: id,
      after: { page: "contact" },
    });
    revalidatePath("/contacts");
  });
}

const setDefaultSchema = z.object({
  viewId: z.string().nullable(),
});

export async function setDefaultContactViewAction(
  payload: z.infer<typeof setDefaultSchema>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "contact.view.set_default" },
    async () => {
      const user = await requireSession();
      const parsed = setDefaultSchema.parse(payload);
      await setDefaultContactView(user.id, parsed.viewId);
      await writeAudit({
        actorId: user.id,
        action: "contact.view.set_default",
        targetType: "saved_view",
        targetId: parsed.viewId?.startsWith("saved:")
          ? parsed.viewId.slice("saved:".length)
          : (parsed.viewId ?? "none"),
        after: { page: "contact", viewId: parsed.viewId },
      });
      revalidatePath("/contacts");
    },
  );
}

const adhocSchema = z.object({
  columns: z
    .array(
      z.enum(
        CONTACT_COLUMN_KEYS as [ContactColumnKey, ...ContactColumnKey[]],
      ),
    )
    .nullable(),
});

export async function setContactAdhocColumnsAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "contact.view.set_adhoc_columns" },
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
      await setContactAdhocColumns(user.id, result.columns);
    },
  );
}

/**
 * reset the current contacts view to its saved definition.
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

export async function resetContactViewAction(
  payload: z.infer<typeof resetSchema>,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "view.reset_to_saved" }, async () => {
    const user = await requireSession();
    const parsed = resetSchema.parse(payload);
    if (parsed.viewId.startsWith("builtin:")) {
      await setContactAdhocColumns(user.id, null);
    }
    await writeAudit({
      actorId: user.id,
      action: "view.reset_to_saved",
      targetType: "saved_view",
      targetId: parsed.viewId.startsWith("saved:")
        ? parsed.viewId.slice("saved:".length)
        : parsed.viewId,
      after: {
        page: "contact",
        viewName: parsed.viewName,
        modifiedFields: parsed.modifiedFields,
      },
    });
  });
}
