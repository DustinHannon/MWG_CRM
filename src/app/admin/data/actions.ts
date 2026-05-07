"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { importJobs } from "@/db/schema/imports";
import { leads } from "@/db/schema/leads";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import { ValidationError } from "@/lib/errors";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

const confirmSchema = z.object({
  confirm: z.string(),
  expected: z.string(),
});

export interface DangerSuccessData {
  affected: number;
}

function expectingConfirmation(formData: FormData, expected: string): void {
  const parsed = confirmSchema.safeParse({
    confirm: formData.get("confirm"),
    expected,
  });
  if (!parsed.success || parsed.data.confirm !== expected) {
    throw new ValidationError(`Type "${expected}" exactly to confirm.`);
  }
}

export async function deleteAllLeadsAction(
  formData: FormData,
): Promise<ActionResult<DangerSuccessData>> {
  return withErrorBoundary(
    { action: "data.delete_all_leads" },
    async (): Promise<DangerSuccessData> => {
      const admin = await requireAdmin();
      expectingConfirmation(formData, "DELETE ALL LEADS");

      // Cascade deletes activities + attachments via FKs.
      const r = await db.execute<{ count: number }>(
        sql`WITH d AS (DELETE FROM ${leads} RETURNING id) SELECT count(*)::int FROM d`,
      );
      const count = r[0]?.count ?? 0;

      await writeAudit({
        actorId: admin.id,
        action: "data.delete_all_leads",
        after: { count },
      });
      revalidatePath("/admin");
      revalidatePath("/leads");
      return { affected: count };
    },
  );
}

export async function deleteAllActivitiesAction(
  formData: FormData,
): Promise<ActionResult<DangerSuccessData>> {
  return withErrorBoundary(
    { action: "data.delete_all_activities" },
    async (): Promise<DangerSuccessData> => {
      const admin = await requireAdmin();
      expectingConfirmation(formData, "DELETE ALL ACTIVITIES");

      // Delete attachments first (they reference activities, cascade would
      // also work but explicit is safer when we want the count of
      // attachments).
      await db.delete(attachments);
      const r = await db.execute<{ count: number }>(
        sql`WITH d AS (DELETE FROM ${activities} RETURNING id) SELECT count(*)::int FROM d`,
      );
      const count = r[0]?.count ?? 0;

      await db.update(leads).set({ lastActivityAt: null });

      await writeAudit({
        actorId: admin.id,
        action: "data.delete_all_activities",
        after: { count },
      });
      revalidatePath("/admin");
      revalidatePath("/leads");
      return { affected: count };
    },
  );
}

export async function deleteAllImportsAction(
  formData: FormData,
): Promise<ActionResult<DangerSuccessData>> {
  return withErrorBoundary(
    { action: "data.delete_all_imports" },
    async (): Promise<DangerSuccessData> => {
      const admin = await requireAdmin();
      expectingConfirmation(formData, "DELETE ALL IMPORTS");

      const r = await db.execute<{ count: number }>(
        sql`WITH d AS (DELETE FROM ${importJobs} RETURNING id) SELECT count(*)::int FROM d`,
      );
      const count = r[0]?.count ?? 0;

      await writeAudit({
        actorId: admin.id,
        action: "data.delete_all_imports",
        after: { count },
      });
      return { affected: count };
    },
  );
}
