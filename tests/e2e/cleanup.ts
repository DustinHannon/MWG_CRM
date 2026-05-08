/**
 * Phase 12 — purge E2E test data from production by run-id tag.
 *
 * Children-first to respect FK CASCADE rules. Activities/tasks cascade
 * automatically when parent is deleted, but we wipe explicitly tagged
 * rows on each table to avoid relying on cascade order.
 *
 * Safety: refuses to run without `E2E_RUN_ID`. Also runs an opportunistic
 * 24h-orphan sweep for rows tagged from prior failed runs, scoped to
 * names that match the [E2E-…] tag pattern only.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../../src/db";

const runId = process.env.E2E_RUN_ID;
if (!runId) {
  console.error("E2E_RUN_ID not set — refusing to clean up.");
  process.exit(1);
}

const pattern = `%[E2E-${runId}]%`;
const orphanCutoff = "NOW() - INTERVAL '24 hours'";

async function clean(label: string, statement: ReturnType<typeof sql>): Promise<void> {
  const r = await db.execute(statement);
  console.log(`[cleanup] ${label}: ${r.length} rows affected`);
}

(async () => {
  // Children first.
  await clean(
    "activities",
    sql`DELETE FROM activities WHERE subject ILIKE ${pattern} OR body ILIKE ${pattern}`,
  );
  await clean(
    "tasks",
    sql`DELETE FROM tasks WHERE title ILIKE ${pattern} OR description ILIKE ${pattern}`,
  );
  await clean(
    "opportunities",
    sql`DELETE FROM opportunities WHERE name ILIKE ${pattern}`,
  );
  await clean(
    "contacts",
    sql`DELETE FROM contacts WHERE first_name ILIKE ${pattern} OR last_name ILIKE ${pattern}`,
  );
  await clean(
    "crm_accounts",
    sql`DELETE FROM crm_accounts WHERE name ILIKE ${pattern}`,
  );
  await clean(
    "leads",
    sql`DELETE FROM leads WHERE first_name ILIKE ${pattern} OR last_name ILIKE ${pattern} OR company_name ILIKE ${pattern}`,
  );
  // Notifications fan-out from test actions also tagged.
  await clean(
    "notifications",
    sql`DELETE FROM notifications WHERE title ILIKE ${pattern} OR body ILIKE ${pattern}`,
  );

  // 24h orphan sweep — any [E2E-…] tagged rows older than 24h, regardless of run-id.
  await clean(
    "orphan-leads",
    sql`DELETE FROM leads
        WHERE (first_name ILIKE '%[E2E-%]%' OR company_name ILIKE '%[E2E-%]%')
          AND created_at < ${sql.raw(orphanCutoff)}`,
  );
  await clean(
    "orphan-accounts",
    sql`DELETE FROM crm_accounts
        WHERE name ILIKE '%[E2E-%]%' AND created_at < ${sql.raw(orphanCutoff)}`,
  );

  console.log("[cleanup] done for E2E_RUN_ID=", runId);
  process.exit(0);
})().catch((err) => {
  console.error("[cleanup] failed", err);
  process.exit(1);
});
