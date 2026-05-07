"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requireSession } from "@/lib/auth-helpers";
import { COLUMN_KEYS, type ColumnKey } from "@/lib/view-constants";
import {
  createSavedView,
  deleteSavedView,
  savedViewSchema,
  setAdhocColumns,
  setLastUsedView,
  updateSavedView,
} from "@/lib/views";

export interface ViewActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

/**
 * Save the current filters/columns/sort as a new view. Called from the
 * "Save current view as…" modal.
 */
export async function createViewAction(
  formData: FormData,
): Promise<ViewActionResult> {
  const user = await requireSession();
  const raw = formData.get("payload");
  if (typeof raw !== "string") {
    return { ok: false, error: "Missing payload." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid payload JSON." };
  }
  const result = savedViewSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error:
        "Validation failed: " +
        Object.values(result.error.flatten().fieldErrors)
          .flat()
          .join("; "),
    };
  }
  try {
    const { id } = await createSavedView(user.id, result.data);
    await writeAudit({
      actorId: user.id,
      action: "view.create",
      targetType: "saved_view",
      targetId: id,
      after: { name: result.data.name },
    });
    revalidatePath("/leads");
    return { ok: true, id };
  } catch (err) {
    if (err instanceof Error && err.message.includes("unique")) {
      return { ok: false, error: "A view with that name already exists." };
    }
    throw err;
  }
}

/**
 * Update an existing saved view (typically: "Save changes" from the
 * Modified-since-saved badge).
 */
export async function updateViewAction(
  formData: FormData,
): Promise<ViewActionResult> {
  const user = await requireSession();
  const id = z.string().uuid().parse(formData.get("id"));
  const raw = formData.get("payload");
  if (typeof raw !== "string") return { ok: false, error: "Missing payload." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid payload JSON." };
  }
  const result = savedViewSchema.partial().safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: "Validation failed.",
    };
  }
  await updateSavedView(user.id, id, result.data);
  await writeAudit({
    actorId: user.id,
    action: "view.update",
    targetType: "saved_view",
    targetId: id,
  });
  revalidatePath("/leads");
  return { ok: true, id };
}

export async function deleteViewAction(formData: FormData) {
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
}

/** Persist last-used view + adhoc column choices. Fire-and-forget. */
export async function trackViewSelection(viewId: string) {
  const user = await requireSession();
  await setLastUsedView(user.id, viewId);
}

const adhocSchema = z.object({
  columns: z
    .array(z.enum(COLUMN_KEYS as [ColumnKey, ...ColumnKey[]]))
    .nullable(),
});

export async function setAdhocColumnsAction(
  formData: FormData,
): Promise<ViewActionResult> {
  const user = await requireSession();
  const raw = formData.get("payload");
  if (typeof raw !== "string") return { ok: false, error: "Missing payload." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid payload JSON." };
  }
  const result = adhocSchema.safeParse(parsed);
  if (!result.success) return { ok: false, error: "Validation failed." };
  await setAdhocColumns(user.id, result.data.columns);
  return { ok: true };
}
