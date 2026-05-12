"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { ConflictError, ValidationError } from "@/lib/errors";
import { COLUMN_KEYS, type ColumnKey } from "@/lib/view-constants";
import {
  createSavedView,
  deleteSavedView,
  savedViewSchema,
  setAdhocColumns,
  setLastUsedView,
  updateSavedView,
} from "@/lib/views";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

export interface ViewIdData {
  id: string;
}

/**
 * Save the current filters/columns/sort as a new view. Called from the
 * "Save current view as…" modal.
 */
export async function createViewAction(
  formData: FormData,
): Promise<ActionResult<ViewIdData>> {
  return withErrorBoundary(
    { action: "view.create" },
    async (): Promise<ViewIdData> => {
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
      const result = savedViewSchema.parse(parsed);

      try {
        const { id } = await createSavedView(user.id, result);
        // Phase 4B — auto-revert: when the user saves the current state as
        // a new view, the originating built-in view's modifications (adhoc
        // columns) should reset so switching back shows clean defaults.
        await setAdhocColumns(user.id, null);
        await writeAudit({
          actorId: user.id,
          action: "view.create",
          targetType: "saved_view",
          targetId: id,
          after: { name: result.name, adhocReverted: true },
        });
        revalidatePath("/leads");
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
 * Update an existing saved view (typically: "Save changes" from the
 * Modified-since-saved badge).
 */
export async function updateViewAction(
  formData: FormData,
): Promise<ActionResult<ViewIdData>> {
  return withErrorBoundary(
    { action: "view.update" },
    async (): Promise<ViewIdData> => {
      const user = await requireSession();
      const id = z.string().uuid().parse(formData.get("id"));
      // Phase 6B — version stamps every saved-view edit.
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
      const result = savedViewSchema.partial().parse(parsed);

      await updateSavedView(user.id, id, version, result);

      await writeAudit({
        actorId: user.id,
        action: "view.update",
        targetType: "saved_view",
        targetId: id,
      });
      revalidatePath("/leads");
      return { id };
    },
  );
}

export async function deleteViewAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "view.delete" }, async () => {
    const user = await requireSession();
    const id = z.string().uuid().parse(formData.get("id"));
    await deleteSavedView(user.id, id);
    await writeAudit({
      actorId: user.id,
      action: "view.delete",
      targetType: "saved_view",
      targetId: id,
    });
    revalidatePath("/leads");
  });
}

/** Persist last-used view + adhoc column choices. Fire-and-forget. */
export async function trackViewSelection(
  viewId: string,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "view.track_selection" }, async () => {
    const user = await requireSession();
    await setLastUsedView(user.id, viewId);
  });
}

const adhocSchema = z.object({
  columns: z
    .array(z.enum(COLUMN_KEYS as [ColumnKey, ...ColumnKey[]]))
    .nullable(),
});

export async function setAdhocColumnsAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "view.set_adhoc_columns" }, async () => {
    const user = await requireSession();
    const raw = formData.get("payload");
    if (typeof raw !== "string") throw new ValidationError("Missing payload.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ValidationError("Invalid payload JSON.");
    }
    const result = adhocSchema.parse(parsed);
    await setAdhocColumns(user.id, result.columns);
  });
}

/**
 * Phase 28 §5 — reset the current view to its saved definition.
 *
 * The client owns the URL navigation (`router.push('/leads?view=...')`);
 * this action handles the server-side side-effects: clear adhoc columns
 * when the active view is a built-in, and emit the audit event so the
 * reset is forensically traceable.
 */
const resetSchema = z.object({
  viewId: z.string(),
  viewName: z.string(),
  modifiedFields: z.array(z.string()),
});

export async function resetViewAction(
  payload: z.infer<typeof resetSchema>,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "view.reset_to_saved" }, async () => {
    const user = await requireSession();
    const parsed = resetSchema.parse(payload);
    // Built-in views store user-side column choices in
    // user_preferences.adhoc_columns. Clearing it here ensures the next
    // render of the built-in view sees its native column defaults.
    if (parsed.viewId.startsWith("builtin:")) {
      await setAdhocColumns(user.id, null);
    }
    await writeAudit({
      actorId: user.id,
      action: "view.reset_to_saved",
      targetType: "saved_view",
      targetId: parsed.viewId.startsWith("saved:")
        ? parsed.viewId.slice("saved:".length)
        : parsed.viewId,
      after: {
        viewName: parsed.viewName,
        modifiedFields: parsed.modifiedFields,
      },
    });
  });
}
