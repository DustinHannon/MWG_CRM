/**
 * Phase 23 — D365 import test cleanup.
 *
 * Removes every row created by the d365-import suite for a given
 * E2E_RUN_ID. Idempotent: re-runnable; only deletes rows tagged with
 * the [E2E-${runId}] sentinel or whose import-pipeline metadata
 * carries `runId`.
 *
 * Cascade order (children-first; FK constraints rely on it):
 *
 *   1. import_records  ← cascades from import_batches (skip explicit; left for safety)
 *   2. import_batches  ← cascades from import_runs (same)
 *   3. external_ids    ← scoped by metadata.testRunId === runId
 *   4. activities / tasks  ← downstream rows committed by the run
 *   5. opportunities / contacts / crm_accounts / leads  ← downstream entities
 *   6. import_runs     ← root rows
 *
 * Wired into the Playwright globalTeardown via `cleanup.ts`. This file
 * exposes a callable `cleanupD365Imports(runId)` so it can also be
 * invoked from `recency-fixture.ts`.
 *
 * SAFETY: refuses to run without `E2E_RUN_ID`. Never deletes rows that
 * lack the sentinel.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../../../src/db";

export async function cleanupD365Imports(runId: string): Promise<void> {
  if (!runId) {
    throw new Error("cleanupD365Imports requires a non-empty runId");
  }

  const tagPattern = `%[E2E-${runId}]%`;
  const log = (label: string, count: number) =>
    console.log(`[d365-cleanup] ${label}: ${count} rows`);

  // 1. Find every import_run whose notes column carries the runId tag.
  //    notes is text but holds JSON-encoded log entries; ILIKE works.
  const runs = await db.execute(sql`
    SELECT id FROM import_runs
    WHERE notes ILIKE ${tagPattern}
       OR scope::text ILIKE ${tagPattern}
  `);
  const runIds: string[] = (runs as unknown as Array<{ id: string }>).map(
    (r) => r.id,
  );
  log("import_runs matched", runIds.length);

  if (runIds.length === 0) {
    // Even with no runs to delete, scrub external_ids stamped with this runId.
    await scrubExternalIdsForRunId(runId, tagPattern);
    return;
  }

  // 2. Collect downstream local IDs we created via committed records.
  const recs = await db.execute(sql`
    SELECT ir.local_id, ir.source_entity_type
    FROM import_records ir
    JOIN import_batches ib ON ib.id = ir.batch_id
    WHERE ib.run_id = ANY(${sql.raw(`ARRAY[${runIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
      AND ir.local_id IS NOT NULL
  `);
  const localByType = new Map<string, string[]>();
  for (const row of recs as unknown as Array<{
    local_id: string;
    source_entity_type: string;
  }>) {
    if (!row.local_id) continue;
    const list = localByType.get(row.source_entity_type) ?? [];
    list.push(row.local_id);
    localByType.set(row.source_entity_type, list);
  }

  // 3. Activities + tasks (cascade-safe but be explicit).
  const leadIds = localByType.get("lead") ?? [];
  const contactIds = localByType.get("contact") ?? [];
  const accountIds = localByType.get("account") ?? [];
  const oppIds = localByType.get("opportunity") ?? [];

  if (leadIds.length || contactIds.length || accountIds.length || oppIds.length) {
    const idArray = [...leadIds, ...contactIds, ...accountIds, ...oppIds];
    if (idArray.length > 0) {
      const literal = idArray.map((id) => `'${id}'`).join(",");
      const r1 = await db.execute(sql`
        DELETE FROM activities
        WHERE lead_id = ANY(${sql.raw(`ARRAY[${literal}]::uuid[]`)})
           OR contact_id = ANY(${sql.raw(`ARRAY[${literal}]::uuid[]`)})
           OR account_id = ANY(${sql.raw(`ARRAY[${literal}]::uuid[]`)})
           OR opportunity_id = ANY(${sql.raw(`ARRAY[${literal}]::uuid[]`)})
      `);
      log("activities", (r1 as { rowCount?: number }).rowCount ?? 0);

      const r2 = await db.execute(sql`
        DELETE FROM tasks
        WHERE lead_id = ANY(${sql.raw(`ARRAY[${literal}]::uuid[]`)})
           OR contact_id = ANY(${sql.raw(`ARRAY[${literal}]::uuid[]`)})
      `);
      log("tasks", (r2 as { rowCount?: number }).rowCount ?? 0);
    }
  }

  // 4. Downstream entities. Children first.
  if (oppIds.length) {
    const r = await db.execute(sql`
      DELETE FROM opportunities WHERE id = ANY(${sql.raw(`ARRAY[${oppIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
    `);
    log("opportunities", (r as { rowCount?: number }).rowCount ?? 0);
  }
  if (contactIds.length) {
    const r = await db.execute(sql`
      DELETE FROM contacts WHERE id = ANY(${sql.raw(`ARRAY[${contactIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
    `);
    log("contacts", (r as { rowCount?: number }).rowCount ?? 0);
  }
  if (accountIds.length) {
    const r = await db.execute(sql`
      DELETE FROM crm_accounts WHERE id = ANY(${sql.raw(`ARRAY[${accountIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
    `);
    log("crm_accounts", (r as { rowCount?: number }).rowCount ?? 0);
  }
  if (leadIds.length) {
    const r = await db.execute(sql`
      DELETE FROM leads WHERE id = ANY(${sql.raw(`ARRAY[${leadIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
    `);
    log("leads", (r as { rowCount?: number }).rowCount ?? 0);
  }

  // 5. external_ids — runs may have been aborted before commit, so scrub by metadata.
  await scrubExternalIdsForRunId(runId, tagPattern);

  // 6. import_runs (cascades to import_batches and import_records).
  const literalRuns = runIds.map((id) => `'${id}'`).join(",");
  const r3 = await db.execute(sql`
    DELETE FROM import_runs WHERE id = ANY(${sql.raw(`ARRAY[${literalRuns}]::uuid[]`)})
  `);
  log("import_runs", (r3 as { rowCount?: number }).rowCount ?? 0);

  // 7. Sentinel-ILIKE sweep for any leftover local entities (defensive).
  await db.execute(sql`
    DELETE FROM leads WHERE first_name ILIKE ${tagPattern} OR last_name ILIKE ${tagPattern} OR company_name ILIKE ${tagPattern}
  `);
  await db.execute(sql`
    DELETE FROM contacts WHERE first_name ILIKE ${tagPattern} OR last_name ILIKE ${tagPattern}
  `);
  await db.execute(sql`
    DELETE FROM crm_accounts WHERE name ILIKE ${tagPattern}
  `);
  await db.execute(sql`
    DELETE FROM activities WHERE subject ILIKE ${tagPattern} OR body ILIKE ${tagPattern}
  `);

  console.log(`[d365-cleanup] done for runId=${runId}`);
}

async function scrubExternalIdsForRunId(
  runId: string,
  tagPattern: string,
): Promise<void> {
  // metadata is a jsonb. Match by either testRunId field or sentinel anywhere.
  const r = await db.execute(sql`
    DELETE FROM external_ids
    WHERE (metadata->>'testRunId') = ${runId}
       OR metadata::text ILIKE ${tagPattern}
  `);
  console.log(
    `[d365-cleanup] external_ids: ${(r as { rowCount?: number }).rowCount ?? 0} rows`,
  );
}

// CLI entry — `pnpm tsx tests/e2e/helpers/import-cleanup.ts`.
if (require.main === module) {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) {
    console.error("E2E_RUN_ID not set — refusing to run.");
    process.exit(1);
  }
  cleanupD365Imports(runId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[d365-cleanup] failed", err);
      process.exit(1);
    });
}
