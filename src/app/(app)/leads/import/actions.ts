"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema/imports";
import { writeAudit } from "@/lib/audit";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { importLeadsFromBuffer, type ImportResult } from "@/lib/xlsx-import";

export interface ImportActionResult {
  ok: boolean;
  error?: string;
  result?: ImportResult;
  jobId?: string;
}

export async function importLeadsAction(
  formData: FormData,
): Promise<ImportActionResult> {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canImport) {
    return { ok: false, error: "You don't have permission to import." };
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file uploaded." };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { ok: false, error: "File too large (10MB max for v1)." };
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return { ok: false, error: "Only .xlsx files are supported." };
  }

  const job = await db
    .insert(importJobs)
    .values({
      userId: user.id,
      filename: file.name,
      status: "processing",
      startedAt: sql`now()`,
    })
    .returning({ id: importJobs.id });
  const jobId = job[0].id;

  try {
    const buf = await file.arrayBuffer();
    const result = await importLeadsFromBuffer(buf, user.id);

    await db
      .update(importJobs)
      .set({
        totalRows: result.totalRows,
        successfulRows: result.successful,
        failedRows: result.failed,
        needsReviewRows: result.needsReview,
        errors: result.errors as unknown as object,
        status: "completed",
        completedAt: sql`now()`,
      })
      .where(sql`id = ${jobId}::uuid`);

    await writeAudit({
      actorId: user.id,
      action: "leads.import",
      targetType: "import_job",
      targetId: jobId,
      after: {
        totalRows: result.totalRows,
        successful: result.successful,
        failed: result.failed,
      },
    });

    revalidatePath("/leads");
    return { ok: true, result, jobId };
  } catch (err) {
    await db
      .update(importJobs)
      .set({
        status: "failed",
        completedAt: sql`now()`,
        errors: [{ row: 0, field: "_fatal", message: String(err) }] as unknown as object,
      })
      .where(sql`id = ${jobId}::uuid`);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Import failed",
      jobId,
    };
  }
}
