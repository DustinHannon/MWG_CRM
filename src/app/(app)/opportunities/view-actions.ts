"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  OPPORTUNITY_COLUMN_KEYS,
  type OpportunityColumnKey,
} from "@/lib/opportunity-view-constants";
import {
  createSavedOpportunityView,
  deleteSavedOpportunityView,
  opportunityViewSchema,
  setDefaultOpportunityView,
  setOpportunityAdhocColumns,
  updateSavedOpportunityView,
} from "@/lib/opportunity-views";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

export interface OpportunityViewIdData {
  id: string;
}

/**
 * Save the current opportunities filters/columns/sort as a new view.
 */
export async function createOpportunityViewAction(
  formData: FormData,
): Promise<ActionResult<OpportunityViewIdData>> {
  return withErrorBoundary(
    { action: "opportunity.view.create" },
    async (): Promise<OpportunityViewIdData> => {
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
      const result = opportunityViewSchema.parse(parsed);

      try {
        const { id } = await createSavedOpportunityView(user.id, result);
        // Auto-revert adhoc on save: when the user crystalises the
        // current state into a new view, clear the originating
        // built-in view's adhoc column choice so switching back
        // shows clean defaults.
        await setOpportunityAdhocColumns(user.id, null);
        await writeAudit({
          actorId: user.id,
          action: "opportunity.view.create",
          targetType: "saved_view",
          targetId: id,
          after: {
            name: result.name,
            page: "opportunity",
            adhocReverted: true,
          },
        });
        revalidatePath("/opportunities");
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
 * Update an existing saved opportunity view.
 */
export async function updateOpportunityViewAction(
  formData: FormData,
): Promise<ActionResult<OpportunityViewIdData>> {
  return withErrorBoundary(
    { action: "opportunity.view.update" },
    async (): Promise<OpportunityViewIdData> => {
      const user = await requireSession();
      const id = z.string().uuid().parse(formData.get("id"));
      const version = z.coerce
        .number()
        .int()
        .positive()
        .parse(formData.get("version"));
      const raw = formData.get("payload");
      if (typeof raw !== "string")
        throw new ValidationError("Missing payload.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ValidationError("Invalid payload JSON.");
      }
      const result = opportunityViewSchema.partial().parse(parsed);

      await updateSavedOpportunityView(user.id, id, version, result);

      await writeAudit({
        actorId: user.id,
        action: "opportunity.view.update",
        targetType: "saved_view",
        targetId: id,
        after: { page: "opportunity" },
      });
      revalidatePath("/opportunities");
      return { id };
    },
  );
}

export async function deleteOpportunityViewAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "opportunity.view.delete" },
    async () => {
      const user = await requireSession();
      const id = z.string().uuid().parse(formData.get("id"));
      await deleteSavedOpportunityView(user.id, id);
      await writeAudit({
        actorId: user.id,
        action: "opportunity.view.delete",
        targetType: "saved_view",
        targetId: id,
        after: { page: "opportunity" },
      });
      revalidatePath("/opportunities");
    },
  );
}

const setDefaultSchema = z.object({
  viewId: z.string().nullable(),
});

export async function setDefaultOpportunityViewAction(
  payload: z.infer<typeof setDefaultSchema>,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "opportunity.view.set_default" },
    async () => {
      const user = await requireSession();
      const parsed = setDefaultSchema.parse(payload);
      await setDefaultOpportunityView(user.id, parsed.viewId);
      await writeAudit({
        actorId: user.id,
        action: "opportunity.view.set_default",
        targetType: "saved_view",
        targetId: parsed.viewId?.startsWith("saved:")
          ? parsed.viewId.slice("saved:".length)
          : (parsed.viewId ?? "none"),
        after: { page: "opportunity", viewId: parsed.viewId },
      });
      revalidatePath("/opportunities");
    },
  );
}

const adhocSchema = z.object({
  columns: z
    .array(
      z.enum(
        OPPORTUNITY_COLUMN_KEYS as [
          OpportunityColumnKey,
          ...OpportunityColumnKey[],
        ],
      ),
    )
    .nullable(),
});

export async function setOpportunityAdhocColumnsAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "opportunity.view.set_adhoc_columns" },
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
      await setOpportunityAdhocColumns(user.id, result.columns);
    },
  );
}

/**
 * reset the current opportunities view to its saved definition.
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

export async function resetOpportunityViewAction(
  payload: z.infer<typeof resetSchema>,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "view.reset_to_saved" }, async () => {
    const user = await requireSession();
    const parsed = resetSchema.parse(payload);
    if (parsed.viewId.startsWith("builtin:")) {
      await setOpportunityAdhocColumns(user.id, null);
    }
    await writeAudit({
      actorId: user.id,
      action: "view.reset_to_saved",
      targetType: "saved_view",
      targetId: parsed.viewId.startsWith("saved:")
        ? parsed.viewId.slice("saved:".length)
        : parsed.viewId,
      after: {
        page: "opportunity",
        viewName: parsed.viewName,
        modifiedFields: parsed.modifiedFields,
      },
    });
  });
}
