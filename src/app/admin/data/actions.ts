"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { activities, attachments } from "@/db/schema/activities";
import { importJobs } from "@/db/schema/imports";
import { leads } from "@/db/schema/leads";
import { writeAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth-helpers";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { rateLimit } from "@/lib/security/rate-limit";
import { gatherBlobsForLeads } from "@/lib/blob-cleanup";
import { enqueueJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

// Per-batch row cap for the cascade DELETEs. Bounds statement runtime
// and lock footprint so one giant DELETE can't exceed the function
// budget or hold table-wide locks all at once.
const DELETE_BATCH = 5000;

/**
 * Content-stable idempotency key for a "delete all" blob-cleanup
 * enqueue. The key is a sha256 over the sorted blob pathname set, NOT
 * the actor id: job-queue idempotency rows are permanent (succeeded
 * jobs are never deleted), so an actor-only key would dedupe against
 * the FIRST delete-all forever — a later delete-all by the same admin
 * (a fresh blob set) would silently skip its own cleanup and orphan
 * those blobs permanently. Hashing the actual payload means a genuine
 * double-submit of the SAME delete (identical blob set) still dedupes
 * to one cleanup, while a genuinely distinct later run (different blob
 * set) enqueues its own. Mirrors the `graph-email` sha256 dedupe-key
 * pattern.
 */
function blobCleanupKey(scope: string, pathnames: readonly string[]): string {
  const digest = createHash("sha256")
    .update([...pathnames].sort().join("\n"))
    .digest("hex");
  return `blob-cleanup:${scope}:${digest}`;
}

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

/**
 * Rate-limit guard for destructive admin "delete all" operations.
 * These are permanently destructive and typed-confirmation-gated; the
 * limit stops a scripted or double-submitted danger op from firing
 * repeatedly. 3 destructive ops per admin per hour is generous for a
 * legitimate operator and tight against accidental/abusive repetition.
 */
async function guardDangerRate(adminId: string): Promise<void> {
  const rl = await rateLimit(
    { kind: "admin_danger_op", principal: adminId },
    3,
    3600,
  );
  if (!rl.allowed) {
    throw new RateLimitError(
      "Too many destructive operations. Wait before trying again.",
    );
  }
}

export async function deleteAllLeadsAction(
  formData: FormData,
): Promise<ActionResult<DangerSuccessData>> {
  return withErrorBoundary(
    { action: "data.delete_all_leads" },
    async (): Promise<DangerSuccessData> => {
      const admin = await requireAdmin();
      await guardDangerRate(admin.id);
      expectingConfirmation(formData, "DELETE ALL LEADS");

      // Gather ALL lead-attachment blob pathnames BEFORE the delete.
      // After the first cascade batch the attachments -> activities ->
      // leads join rows are gone and the blob objects leak forever, so
      // this MUST run before the delete loop. No id filter: this purges
      // every lead, so every lead's blobs go. Gather failure is
      // non-fatal — the delete still proceeds (DB is source of truth).
      let blobPathnames: string[] = [];
      try {
        const idRows = await db.select({ id: leads.id }).from(leads);
        const allIds = idRows.map((r) => r.id);
        blobPathnames =
          allIds.length > 0 ? await gatherBlobsForLeads(allIds) : [];
      } catch (err) {
        logger.error("blob_cleanup_gather_failure_delete_all_leads", {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }

      // Batched cascade DELETE. Each iteration deletes at most
      // DELETE_BATCH leads (cascading activities + attachments + tags
      // via FKs). Looping bounds per-statement runtime/locks so a huge
      // table can't blow the function budget in one statement.
      let count = 0;
      for (;;) {
        const r = await db.execute<{ n: number }>(sql`
          WITH d AS (
            DELETE FROM ${leads}
            WHERE id IN (SELECT id FROM ${leads} LIMIT ${DELETE_BATCH})
            RETURNING id
          ) SELECT count(*)::int AS n FROM d
        `);
        const n = r[0]?.n ?? 0;
        count += n;
        if (n < DELETE_BATCH) break;
      }

      // Audit AFTER the delete completes — written even though the
      // delete was batched, so a forensic record always lands.
      await writeAudit({
        actorId: admin.id,
        action: "data.delete_all_leads",
        after: { count },
      });

      // Durable async blob cleanup via the job queue (mirrors
      // hardDeleteLeadAction). No `origin` — this is a multi-entity
      // global op, not one entity. Enqueue failure logs but does not
      // roll back the delete (DB is source of truth).
      if (blobPathnames.length > 0) {
        try {
          await enqueueJob(
            "blob-cleanup",
            { pathnames: blobPathnames },
            {
              actorId: admin.id,
              idempotencyKey: blobCleanupKey(
                "data.delete_all_leads",
                blobPathnames,
              ),
              metadata: {
                originAction: "data.delete_all_leads",
                leadCount: count,
                blobCount: blobPathnames.length,
              },
            },
          );
        } catch (err) {
          logger.error("blob_cleanup_enqueue_failure_delete_all_leads", {
            blobCount: blobPathnames.length,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

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
      await guardDangerRate(admin.id);
      expectingConfirmation(formData, "DELETE ALL ACTIVITIES");

      // Gather attachment blob pathnames BEFORE the delete — the
      // attachments rows vanish on the activities/attachments delete.
      // Gather failure is non-fatal; the delete still proceeds.
      let blobPathnames: string[] = [];
      try {
        const rows = await db
          .select({ pathname: attachments.blobPathname })
          .from(attachments);
        blobPathnames = rows.map((r) => r.pathname);
      } catch (err) {
        logger.error("blob_cleanup_gather_failure_delete_all_activities", {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }

      // The 3 mutations must be atomic: delete attachments + all
      // activities, then null leads.last_activity_at. Without a
      // transaction a crash/timeout between statements (or a concurrent
      // activity insert) leaves last_activity_at inconsistent. A
      // failed transaction throws (typed via the error boundary) and
      // the audit row is correctly NOT written for a non-delete.
      let count = 0;
      try {
        await db.transaction(async (tx) => {
          await tx.delete(attachments);
          const r = await tx.execute<{ n: number }>(
            sql`WITH d AS (DELETE FROM ${activities} RETURNING id) SELECT count(*)::int AS n FROM d`,
          );
          count = r[0]?.n ?? 0;
          await tx.update(leads).set({ lastActivityAt: null });
        });
      } catch (err) {
        logger.error("data_delete_all_activities_transaction_failure", {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Audit AFTER the transaction commits (never inside the tx).
      await writeAudit({
        actorId: admin.id,
        action: "data.delete_all_activities",
        after: { count },
      });

      if (blobPathnames.length > 0) {
        try {
          await enqueueJob(
            "blob-cleanup",
            { pathnames: blobPathnames },
            {
              actorId: admin.id,
              idempotencyKey: blobCleanupKey(
                "data.delete_all_activities",
                blobPathnames,
              ),
              metadata: {
                originAction: "data.delete_all_activities",
                activityCount: count,
                blobCount: blobPathnames.length,
              },
            },
          );
        } catch (err) {
          logger.error(
            "blob_cleanup_enqueue_failure_delete_all_activities",
            {
              blobCount: blobPathnames.length,
              errorMessage:
                err instanceof Error ? err.message : String(err),
            },
          );
        }
      }

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
      await guardDangerRate(admin.id);
      expectingConfirmation(formData, "DELETE ALL IMPORTS");

      // import_jobs has no attachment/blob graph (only FK is
      // user_id SET NULL; leads.import_job_id SET NULL). No blob
      // cleanup needed. Batched DELETE for symmetry / lock bounding;
      // single-statement per batch so no transaction needed.
      let count = 0;
      for (;;) {
        const r = await db.execute<{ n: number }>(sql`
          WITH d AS (
            DELETE FROM ${importJobs}
            WHERE id IN (SELECT id FROM ${importJobs} LIMIT ${DELETE_BATCH})
            RETURNING id
          ) SELECT count(*)::int AS n FROM d
        `);
        const n = r[0]?.n ?? 0;
        count += n;
        if (n < DELETE_BATCH) break;
      }

      await writeAudit({
        actorId: admin.id,
        action: "data.delete_all_imports",
        after: { count },
      });
      return { affected: count };
    },
  );
}
