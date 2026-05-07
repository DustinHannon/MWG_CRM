"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema/imports";
import { writeAudit } from "@/lib/audit";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { commitImport, type CommitResult } from "@/lib/import/commit";
import { parseWorkbookBuffer } from "@/lib/import/parse-workbook";
import { buildImportPreview, type ImportPreview } from "@/lib/import/preview";
import { deleteJob, getJob, putJob } from "@/lib/import/job-cache";
import { logger } from "@/lib/logger";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

export interface PreviewSuccessData {
  jobId: string;
  fileName: string;
  smartDetect: boolean;
  preview: ImportPreview;
}

export interface CommitSuccessData {
  result: CommitResult;
  jobId: string;
}

/**
 * Phase 6E + 6F — preview step. Parse the upload, build the aggregate
 * counts/warnings/errors, cache the parsed rows under a job id. The
 * user then reviews and clicks Commit.
 */
export async function previewImportAction(
  formData: FormData,
): Promise<ActionResult<PreviewSuccessData>> {
  return withErrorBoundary(
    { action: "import.preview" },
    async (): Promise<PreviewSuccessData> => {
      const user = await requireSession();
      const perms = await getPermissions(user.id);
      if (!user.isAdmin && !perms.canImport) {
        throw new ForbiddenError("You don't have permission to import.");
      }

      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new ValidationError("No file uploaded.");
      }
      if (file.size > 10 * 1024 * 1024) {
        throw new ValidationError("File too large (10MB max for v1).");
      }
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        throw new ValidationError("Only .xlsx files are supported.");
      }

      const smartDetect = formData.get("smartDetect") === "on";

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
        const parsed = await parseWorkbookBuffer({ buffer: buf, smartDetect });
        const preview = await buildImportPreview({
          parseRows: parsed.rows,
          smartDetect,
          unknownHeaders: parsed.unknownHeaders,
          missingRequiredHeaders: parsed.missingRequiredHeaders,
        });

        putJob({
          jobId,
          userId: user.id,
          fileName: file.name,
          smartDetect,
          parseRows: parsed.rows,
          unknownHeaders: parsed.unknownHeaders,
          missingRequiredHeaders: parsed.missingRequiredHeaders,
        });

        await db
          .update(importJobs)
          .set({
            totalRows: parsed.totalRows,
            status: "preview",
          })
          .where(sql`id = ${jobId}::uuid`);

        return { jobId, fileName: file.name, smartDetect, preview };
      } catch (err) {
        // Log full err detail server-side; surface a redacted message in DB.
        logger.error("import.preview_failed", {
          jobId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        await db
          .update(importJobs)
          .set({
            status: "failed",
            completedAt: sql`now()`,
            errors: [
              { row: 0, field: "_fatal", message: "Preview failed." },
            ] as unknown as object,
          })
          .where(sql`id = ${jobId}::uuid`);
        // Re-throw so withErrorBoundary handles the public response.
        throw err;
      }
    },
  );
}

/**
 * Phase 6E + 6F — commit step. Reads the cached job, runs the chunked
 * write pipeline, audit-logs the snapshot.
 */
export async function commitImportAction(
  jobId: string,
): Promise<ActionResult<CommitSuccessData>> {
  return withErrorBoundary(
    { action: "import.commit", entityType: "import_job", entityId: jobId },
    async (): Promise<CommitSuccessData> => {
      const user = await requireSession();
      const perms = await getPermissions(user.id);
      if (!user.isAdmin && !perms.canImport) {
        throw new ForbiddenError("You don't have permission to import.");
      }

      const cached = getJob(jobId, user.id);
      if (!cached) {
        throw new NotFoundError(
          "preview (it may have expired — please re-upload)",
        );
      }

      try {
        // Filter to OK rows only — failed rows already surfaced in the
        // preview's errors list and are recorded in the audit log.
        const okRows = cached.parseRows.filter(
          (r): r is Extract<typeof r, { ok: true }> => r.ok,
        );
        const result = await commitImport({
          rows: okRows,
          importerUserId: user.id,
          importJobId: jobId,
          importFileName: cached.fileName,
        });

        await db
          .update(importJobs)
          .set({
            status: "completed",
            completedAt: sql`now()`,
            successfulRows:
              result.insertedLeadIds.length + result.updatedLeadIds.length,
            failedRows: result.failedRows.length,
            errors: result.failedRows as unknown as object,
          })
          .where(sql`id = ${jobId}::uuid`);

        await writeAudit({
          actorId: user.id,
          action: "leads.import",
          targetType: "import_job",
          targetId: jobId,
          after: {
            fileName: cached.fileName,
            smartDetect: cached.smartDetect,
            inserted: result.insertedLeadIds.length,
            updated: result.updatedLeadIds.length,
            activitiesInserted: result.insertedActivityCount,
            activitiesSkipped: result.skippedActivityCount,
            opportunitiesInserted: result.insertedOpportunityIds.length,
            failedRows: result.failedRows.length,
          },
        });

        deleteJob(jobId);
        revalidatePath("/leads");
        return { result, jobId };
      } catch (err) {
        logger.error("import.commit_failed", {
          jobId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        await db
          .update(importJobs)
          .set({
            status: "failed",
            completedAt: sql`now()`,
            errors: [
              { row: 0, field: "_fatal", message: "Commit failed." },
            ] as unknown as object,
          })
          .where(sql`id = ${jobId}::uuid`);
        throw err;
      }
    },
  );
}

export async function cancelImportAction(
  jobId: string,
): Promise<ActionResult> {
  return withErrorBoundary(
    { action: "import.cancel", entityType: "import_job", entityId: jobId },
    async () => {
      const user = await requireSession();
      const cached = getJob(jobId, user.id);
      if (cached) deleteJob(jobId);
      // NOTE: ownership check on DB row is handled in Wave 4 (FIX-008).
      await db
        .update(importJobs)
        .set({
          status: "cancelled",
          completedAt: sql`now()`,
        })
        .where(sql`id = ${jobId}::uuid`);
    },
  );
}
