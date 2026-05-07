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

const confirmSchema = z.object({
  confirm: z.string(),
  expected: z.string(),
});

export interface DangerActionResult {
  ok: boolean;
  error?: string;
  affected?: number;
}

async function expectingConfirmation(
  formData: FormData,
  expected: string,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = confirmSchema.safeParse({
    confirm: formData.get("confirm"),
    expected,
  });
  if (!parsed.success || parsed.data.confirm !== expected) {
    return {
      ok: false,
      error: `Type "${expected}" exactly to confirm.`,
    };
  }
  return { ok: true };
}

export async function deleteAllLeadsAction(
  formData: FormData,
): Promise<DangerActionResult> {
  const admin = await requireAdmin();
  const check = await expectingConfirmation(formData, "DELETE ALL LEADS");
  if (!check.ok) return { ok: false, error: check.error };

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
  return { ok: true, affected: count };
}

export async function deleteAllActivitiesAction(
  formData: FormData,
): Promise<DangerActionResult> {
  const admin = await requireAdmin();
  const check = await expectingConfirmation(formData, "DELETE ALL ACTIVITIES");
  if (!check.ok) return { ok: false, error: check.error };

  // Delete attachments first (they reference activities, cascade would also
  // work but explicit is safer when we want the count of attachments).
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
  return { ok: true, affected: count };
}

export async function deleteAllImportsAction(
  formData: FormData,
): Promise<DangerActionResult> {
  const admin = await requireAdmin();
  const check = await expectingConfirmation(formData, "DELETE ALL IMPORTS");
  if (!check.ok) return { ok: false, error: check.error };

  const r = await db.execute<{ count: number }>(
    sql`WITH d AS (DELETE FROM ${importJobs} RETURNING id) SELECT count(*)::int FROM d`,
  );
  const count = r[0]?.count ?? 0;

  await writeAudit({
    actorId: admin.id,
    action: "data.delete_all_imports",
    after: { count },
  });
  return { ok: true, affected: count };
}
