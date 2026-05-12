"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { listImportRuns } from "@/db/schema/list-import-runs";
import {
  marketingLists,
  marketingStaticListMembers,
} from "@/db/schema/marketing-lists";
import { writeAudit } from "@/lib/audit";
import {
  getPermissions,
  requireSession,
  type SessionUser,
} from "@/lib/auth-helpers";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  MARKETING_AUDIT_EVENTS,
} from "@/lib/marketing/audit-events";
import { createStaticListMembers } from "@/lib/marketing/lists/static-members";
import {
  parseStaticListWorkbook,
  type StaticImportError,
  type StaticImportRow,
} from "@/lib/marketing/lists/static-import-parse";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

/**
 * Phase 29 §6 — Server actions for the static-list Excel import wizard.
 *
 * Three actions mirroring the leads-import shape:
 *   • previewStaticListImportAction → parse workbook, persist parsed rows
 *     + per-row errors to `list_import_runs`, return preview payload.
 *   • commitStaticListImportAction  → read persisted parsed rows, chunk-
 *     insert into `marketing_static_list_members`, audit, return summary.
 *   • cancelStaticListImportAction  → mark the run row 'cancelled'.
 *
 * Permission gate (preview + commit): admin OR
 * `canMarketingListsImport` OR `canMarketingListsEdit` OR the list's
 * creator (for "edit own" semantics).
 */

/**
 * Phase 29 brief — locked default. The brief's §0 caps Excel import
 * size at 10 MB. Kept in this file (not env) so we don't add an
 * unnecessary deploy-config knob.
 */
const STATIC_LIST_IMPORT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Phase 29 brief — locked default. Chunked insert size for the commit
 * step. Matches `MARKETING_LIST_IMPORT_BATCH_SIZE` from the brief.
 */
const STATIC_LIST_IMPORT_BATCH_SIZE = 500;

/**
 * XLSX magic bytes — every .xlsx is a ZIP starting with PK\x03\x04.
 * Same gate the leads-import path uses to reject renamed binaries.
 */
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

function looksLikeXlsx(buf: Uint8Array): boolean {
  if (buf.byteLength < XLSX_MAGIC.length) return false;
  for (let i = 0; i < XLSX_MAGIC.length; i++) {
    if (buf[i] !== XLSX_MAGIC[i]) return false;
  }
  return true;
}

export interface PreviewSmartDetect {
  emailColumn: number | null;
  nameColumn: number | null;
  confident: boolean;
  unknownHeaders: string[];
}

export interface PreviewStaticListImportData {
  jobId: string;
  fileName: string;
  /** Per-row outcome from validation (capped to 500 sample rows). */
  preview: StaticImportRow[];
  /** Row-level validation errors (capped to 500 sample errors). */
  errors: StaticImportError[];
  smartDetect: PreviewSmartDetect;
  totalRows: number;
  successfulRows: number;
  invalidRows: number;
  duplicateRows: number;
  resumed: boolean;
}

export interface CommitStaticListImportData {
  runId: string;
  inserted: number;
  skipped: number;
  failed: number;
  total: number;
}

interface PersistedRunRow {
  id: string;
  listId: string;
  userId: string | null;
  filename: string;
  totalRows: number;
  successfulRows: number;
  failedRows: number;
  needsReviewRows: number;
  errors: unknown;
  parsedRows: unknown;
  status: string;
}

interface AccessCheckResult {
  list: {
    id: string;
    name: string;
    createdById: string;
    listType: "dynamic" | "static_imported";
  };
}

/**
 * Permission gate: admin OR `canMarketingListsImport` OR
 * `canMarketingListsEdit` OR creator-match.
 */
async function requireStaticListImportAccess(
  user: SessionUser,
  listId: string,
): Promise<AccessCheckResult> {
  const [list] = await db
    .select({
      id: marketingLists.id,
      name: marketingLists.name,
      createdById: marketingLists.createdById,
      listType: marketingLists.listType,
      isDeleted: marketingLists.isDeleted,
    })
    .from(marketingLists)
    .where(eq(marketingLists.id, listId))
    .limit(1);
  if (!list || list.isDeleted) throw new NotFoundError("marketing list");
  if (list.listType !== "static_imported") {
    throw new ValidationError(
      "This action is only valid for static-imported lists.",
    );
  }
  if (user.isAdmin) {
    return {
      list: {
        id: list.id,
        name: list.name,
        createdById: list.createdById,
        listType: list.listType,
      },
    };
  }
  const perms = await getPermissions(user.id);
  const isCreator = list.createdById === user.id;
  if (
    !perms.canMarketingListsImport &&
    !perms.canMarketingListsEdit &&
    !perms.canManageMarketing &&
    !isCreator
  ) {
    throw new ForbiddenError(
      "You don't have permission to import into this list.",
    );
  }
  return {
    list: {
      id: list.id,
      name: list.name,
      createdById: list.createdById,
      listType: list.listType,
    },
  };
}

/**
 * Phase 29 §6 — Preview step. Parse workbook, persist rows + errors to
 * `list_import_runs`. If `formData` carries a `resumeRunId`, return
 * the persisted snapshot instead of re-parsing.
 */
export async function previewStaticListImportAction(
  listId: string,
  formData: FormData,
): Promise<ActionResult<PreviewStaticListImportData>> {
  return withErrorBoundary(
    {
      action: "marketing.list.import.preview",
      entityType: "marketing_list",
      entityId: listId,
    },
    async (): Promise<PreviewStaticListImportData> => {
      const user = await requireSession();
      await requireStaticListImportAccess(user, listId);

      // Resume path.
      const resumeRunId = formData.get("resumeRunId");
      if (typeof resumeRunId === "string" && resumeRunId.length > 0) {
        return resumePreview({
          runId: resumeRunId,
          listId,
          userId: user.id,
        });
      }

      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new ValidationError("No file uploaded.");
      }
      if (file.size > STATIC_LIST_IMPORT_MAX_BYTES) {
        throw new ValidationError(
          `File too large (max ${(STATIC_LIST_IMPORT_MAX_BYTES / 1024 / 1024).toFixed(0)} MB).`,
        );
      }
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        throw new ValidationError("Only .xlsx files are supported.");
      }

      const buf = await file.arrayBuffer();
      const view = new Uint8Array(buf);
      if (!looksLikeXlsx(view)) {
        throw new ValidationError(
          "File does not look like a valid .xlsx workbook.",
        );
      }

      const [run] = await db
        .insert(listImportRuns)
        .values({
          listId,
          userId: user.id,
          filename: file.name,
          status: "previewing",
          startedAt: sql`now()`,
        })
        .returning({ id: listImportRuns.id });
      const runId = run.id;

      try {
        // Pull existing emails for cross-list dedup. Always lower-cased
        // because the unique index is on `lower(email)`.
        const existingRows = await db
          .select({ email: marketingStaticListMembers.email })
          .from(marketingStaticListMembers)
          .where(eq(marketingStaticListMembers.listId, listId));
        const existingEmails = new Set(
          existingRows.map((r) => r.email.trim().toLowerCase()),
        );

        const parsed = await parseStaticListWorkbook({
          buffer: buf,
          existingEmails,
        });

        await db
          .update(listImportRuns)
          .set({
            totalRows: parsed.totalRows,
            successfulRows: parsed.successfulRows,
            failedRows: parsed.failedRows,
            needsReviewRows: parsed.duplicateRows,
            errors: parsed.errors as unknown as object,
            parsedRows: parsed.rows as unknown as object,
            status: "previewing",
          })
          .where(eq(listImportRuns.id, runId));

        return buildPreviewResponse({
          runId,
          fileName: file.name,
          rows: parsed.rows,
          errors: parsed.errors,
          detect: {
            emailColumn: parsed.detect.emailColumn,
            nameColumn: parsed.detect.nameColumn,
            confident: parsed.detect.confident,
            unknownHeaders: parsed.detect.unknownHeaders,
          },
          totalRows: parsed.totalRows,
          successfulRows: parsed.successfulRows,
          invalidRows: parsed.failedRows,
          duplicateRows: parsed.duplicateRows,
          resumed: false,
        });
      } catch (err) {
        logger.error("list_import_preview_failure", {
          runId,
          listId,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
        });
        await db
          .update(listImportRuns)
          .set({
            status: "cancelled",
            completedAt: sql`now()`,
            errors: [
              {
                row: 0,
                field: null,
                code: "PREVIEW_FAILED",
                message: `Preview failed. Contact support with run id ${runId}.`,
              },
            ] as unknown as object,
          })
          .where(eq(listImportRuns.id, runId));
        throw err;
      }
    },
  );
}

async function resumePreview(args: {
  runId: string;
  listId: string;
  userId: string;
}): Promise<PreviewStaticListImportData> {
  const [row] = await db
    .select()
    .from(listImportRuns)
    .where(
      and(
        eq(listImportRuns.id, args.runId),
        eq(listImportRuns.listId, args.listId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("import run");
  if (row.userId && row.userId !== args.userId) {
    throw new ForbiddenError(
      "You can only resume imports you started.",
    );
  }
  if (row.status !== "previewing") {
    throw new ValidationError(
      "This import is no longer in a resumable state.",
    );
  }
  const parsedRows = Array.isArray(row.parsedRows)
    ? (row.parsedRows as StaticImportRow[])
    : [];
  const errors = Array.isArray(row.errors)
    ? (row.errors as StaticImportError[])
    : [];
  const successfulRows = parsedRows.filter((r) => r.status === "ok").length;
  const invalidRows = parsedRows.filter((r) => r.status === "invalid").length;
  const duplicateRows = parsedRows.filter(
    (r) => r.status === "duplicate",
  ).length;
  return buildPreviewResponse({
    runId: row.id,
    fileName: row.filename,
    rows: parsedRows,
    errors,
    detect: {
      emailColumn: null,
      nameColumn: null,
      confident: false,
      unknownHeaders: [],
    },
    totalRows: parsedRows.length,
    successfulRows,
    invalidRows,
    duplicateRows,
    resumed: true,
  });
}

interface BuildPreviewResponseArgs {
  runId: string;
  fileName: string;
  rows: StaticImportRow[];
  errors: StaticImportError[];
  detect: PreviewSmartDetect;
  totalRows: number;
  successfulRows: number;
  invalidRows: number;
  duplicateRows: number;
  resumed: boolean;
}

/**
 * Cap preview payload size — we only need a sample of rows / errors to
 * render the wizard. The full parsed rows still live in the DB for the
 * commit step.
 */
const PREVIEW_SAMPLE_CAP = 500;

function buildPreviewResponse(
  args: BuildPreviewResponseArgs,
): PreviewStaticListImportData {
  return {
    jobId: args.runId,
    fileName: args.fileName,
    preview: args.rows.slice(0, PREVIEW_SAMPLE_CAP),
    errors: args.errors.slice(0, PREVIEW_SAMPLE_CAP),
    smartDetect: args.detect,
    totalRows: args.totalRows,
    successfulRows: args.successfulRows,
    invalidRows: args.invalidRows,
    duplicateRows: args.duplicateRows,
    resumed: args.resumed,
  };
}

/**
 * Phase 29 §6 — Commit step. Reads the persisted run row, inserts the
 * `status === 'ok'` rows in batches of 500, audits the summary.
 */
export async function commitStaticListImportAction(
  runId: string,
): Promise<ActionResult<CommitStaticListImportData>> {
  return withErrorBoundary(
    {
      action: "marketing.list.import.commit",
      entityType: "list_import_run",
      entityId: runId,
    },
    async (): Promise<CommitStaticListImportData> => {
      const user = await requireSession();
      const run = await loadRun(runId, user);
      const { list } = await requireStaticListImportAccess(user, run.listId);

      if (run.status !== "previewing") {
        throw new ValidationError(
          "Import is no longer in a committable state.",
        );
      }

      const parsedRows = Array.isArray(run.parsedRows)
        ? (run.parsedRows as StaticImportRow[])
        : [];
      const okRows = parsedRows.filter((r) => r.status === "ok");
      const skipped = parsedRows.length - okRows.length;

      await db
        .update(listImportRuns)
        .set({ status: "committing" })
        .where(eq(listImportRuns.id, runId));

      try {
        let inserted = 0;
        for (let i = 0; i < okRows.length; i += STATIC_LIST_IMPORT_BATCH_SIZE) {
          const slice = okRows.slice(i, i + STATIC_LIST_IMPORT_BATCH_SIZE);
          const result = await createStaticListMembers({
            listId: run.listId,
            members: slice.map((r) => ({ email: r.email, name: r.name })),
            actorId: user.id,
          });
          inserted += result.inserted;
        }

        const failed = Math.max(0, okRows.length - inserted);
        const status = failed === 0 ? "success" : "partial_failure";

        await db
          .update(listImportRuns)
          .set({
            status,
            completedAt: sql`now()`,
            successfulRows: inserted,
            failedRows: failed,
            // Clear the parsed-rows blob now that the commit is done.
            parsedRows: null,
          })
          .where(eq(listImportRuns.id, runId));

        await writeAudit({
          actorId: user.id,
          action: MARKETING_AUDIT_EVENTS.LIST_IMPORTED,
          targetType: "marketing_list",
          targetId: run.listId,
          after: {
            runId,
            total: parsedRows.length,
            successful: inserted,
            failed,
            skipped,
            fileName: run.filename,
          },
        });

        revalidatePath(`/marketing/lists/${list.id}`);

        return {
          runId,
          inserted,
          skipped,
          failed,
          total: parsedRows.length,
        };
      } catch (err) {
        logger.error("list_import_commit_failure", {
          runId,
          listId: run.listId,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
        });
        await db
          .update(listImportRuns)
          .set({
            status: "partial_failure",
            completedAt: sql`now()`,
            errors: [
              {
                row: 0,
                field: null,
                code: "COMMIT_FAILED",
                message: `Commit failed. Contact support with run id ${runId}.`,
              },
            ] as unknown as object,
          })
          .where(eq(listImportRuns.id, runId));
        throw err;
      }
    },
  );
}

export async function cancelStaticListImportAction(
  runId: string,
): Promise<ActionResult> {
  return withErrorBoundary(
    {
      action: "marketing.list.import.cancel",
      entityType: "list_import_run",
      entityId: runId,
    },
    async () => {
      const user = await requireSession();
      const whereExpr = user.isAdmin
        ? eq(listImportRuns.id, runId)
        : and(
            eq(listImportRuns.id, runId),
            eq(listImportRuns.userId, user.id),
          );
      // Only previewing / committing runs are cancellable. Already-
      // completed runs are immutable to keep the audit trail clean.
      const updated = await db
        .update(listImportRuns)
        .set({
          status: "cancelled",
          completedAt: sql`now()`,
          parsedRows: null,
        })
        .where(
          and(
            whereExpr,
            inArray(listImportRuns.status, ["previewing", "committing"]),
          ),
        )
        .returning({ id: listImportRuns.id });
      if (updated.length === 0) {
        throw new NotFoundError("import run");
      }
    },
  );
}

async function loadRun(
  runId: string,
  user: SessionUser,
): Promise<PersistedRunRow> {
  const [row] = await db
    .select({
      id: listImportRuns.id,
      listId: listImportRuns.listId,
      userId: listImportRuns.userId,
      filename: listImportRuns.filename,
      totalRows: listImportRuns.totalRows,
      successfulRows: listImportRuns.successfulRows,
      failedRows: listImportRuns.failedRows,
      needsReviewRows: listImportRuns.needsReviewRows,
      errors: listImportRuns.errors,
      parsedRows: listImportRuns.parsedRows,
      status: listImportRuns.status,
    })
    .from(listImportRuns)
    .where(eq(listImportRuns.id, runId))
    .limit(1);
  if (!row) throw new NotFoundError("import run");
  if (!user.isAdmin && row.userId && row.userId !== user.id) {
    throw new NotFoundError("import run");
  }
  return row;
}
