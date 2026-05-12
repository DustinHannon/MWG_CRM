"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
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
import { MAX_IMPORT_BYTES } from "@/lib/validation/primitives";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * XLSX is a ZIP archive — every file starts with the local-file-header
 * magic 50 4B 03 04. Reject anything else before passing the buffer to
 * the workbook parser; some old "rename .exe → .xlsx" tricks otherwise
 * slip past the extension check.
 */
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

function looksLikeXlsx(buf: Uint8Array): boolean {
  if (buf.byteLength < XLSX_MAGIC.length) return false;
  for (let i = 0; i < XLSX_MAGIC.length; i++) {
    if (buf[i] !== XLSX_MAGIC[i]) return false;
  }
  return true;
}

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
 * preview step. Parse the upload, build the aggregate
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
      // use the shared MAX_IMPORT_BYTES
      // constant so admin-tunable limits live in one place.
      if (file.size > MAX_IMPORT_BYTES) {
        throw new ValidationError(
          `File too large (max ${(MAX_IMPORT_BYTES / 1024 / 1024).toFixed(0)} MB).`,
        );
      }
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        throw new ValidationError("Only .xlsx files are supported.");
      }

      const smartDetect = formData.get("smartDetect") === "on";

      // magic-byte gate runs before the
      // workbook parser opens the buffer. Catches `evil.exe` renamed
      // to `.xlsx` and other content-type spoofs that the extension
      // check above cannot.
      const buf = await file.arrayBuffer();
      const view = new Uint8Array(buf);
      if (!looksLikeXlsx(view)) {
        throw new ValidationError(
          "File does not look like a valid .xlsx workbook.",
        );
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
        // full error detail goes
        // to the structured logger ONLY. The DB row gets a generic
        // public message + the job id so support can find the matching
        // log entry without any sensitive content (connection strings,
        // stack traces, SQL fragments) ever surfacing to end users.
        logger.error("import_preview_failure", {
          jobId,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
        });
        await db
          .update(importJobs)
          .set({
            status: "failed",
            completedAt: sql`now()`,
            errors: [
              {
                row: 0,
                field: "_fatal",
                message: `Preview failed. Contact support with import job id ${jobId}.`,
              },
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
 * commit step. Reads the cached job, runs the chunked
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
        // sanitize: full err only
        // to logger; DB row carries a generic public message tagged
        // with the job id for support correlation.
        logger.error("import_commit_failure", {
          jobId,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
        });
        await db
          .update(importJobs)
          .set({
            status: "failed",
            completedAt: sql`now()`,
            errors: [
              {
                row: 0,
                field: "_fatal",
                message: `Import failed during commit. Contact support with import job id ${jobId}.`,
              },
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
      // DB-row ownership is now enforced.
      // Non-admins can only cancel jobs they themselves started; admins
      // can cancel anyone's. Without this WHERE filter, any signed-in
      // user who learned a job id (URL, log line) could cancel another
      // user's in-flight import.
      const whereExpr = user.isAdmin
        ? eq(importJobs.id, jobId)
        : and(
            eq(importJobs.id, jobId),
            eq(importJobs.userId, user.id),
          );
      const updated = await db
        .update(importJobs)
        .set({
          status: "cancelled",
          completedAt: sql`now()`,
        })
        .where(whereExpr)
        .returning({ id: importJobs.id });
      if (updated.length === 0) {
        // Either the job id doesn't exist or it belongs to another
        // user. Either way: a 404 is the right response — never
        // confirm or deny existence to a non-owner.
        throw new NotFoundError("import job");
      }
    },
  );
}
