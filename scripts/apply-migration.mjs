/**
 * scripts/apply-migration.mjs
 *
 * Apply a single Drizzle-generated SQL migration to production.
 *
 * Used when the Supabase MCP `apply_migration` tool is unavailable from
 * the agent session and a migration still needs to land. The script
 * connects via the same Supavisor pooler the app uses (POSTGRES_URL),
 * splits the SQL file on `--> statement-breakpoint`, and executes each
 * statement in sequence inside a single transaction so partial-apply
 * cannot leave the schema in a torn state.
 *
 * Run:
 *   pnpm dlx tsx --env-file .env.local scripts/apply-migration.mjs \
 *     drizzle/0014_phase32_7_job_queue.sql
 *
 * Safety notes:
 *   - Idempotent SQL is a non-goal; rerunning the script on already-applied
 *     migrations WILL fail with "relation already exists". Run only on
 *     migrations that have not yet been applied.
 *   - The script does NOT update the journal — that's `pnpm db:generate`'s
 *     responsibility before this runs.
 *   - The transaction makes partial failure visible (whole migration
 *     rolled back) rather than silently torn.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const [, , relPath] = process.argv;
if (!relPath) {
  console.error("Usage: apply-migration.mjs <path-to-sql>");
  process.exit(1);
}

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("POSTGRES_URL not set; ensure .env.local is loaded");
  process.exit(1);
}

const absPath = resolve(process.cwd(), relPath);
const raw = readFileSync(absPath, "utf8");
const statements = raw
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

console.log(`[apply-migration] ${absPath}`);
console.log(`[apply-migration] ${statements.length} statement(s)`);

const client = postgres(url, {
  prepare: false,
  max: 1,
  ssl: "require",
  connection: { search_path: "public, extensions" },
});

try {
  await client.begin(async (tx) => {
    for (let i = 0; i < statements.length; i += 1) {
      const stmt = statements[i];
      const preview = stmt.slice(0, 80).replace(/\s+/g, " ");
      console.log(`[apply-migration]  [${i + 1}/${statements.length}] ${preview}…`);
      await tx.unsafe(stmt);
    }
  });
  console.log("[apply-migration] committed");
} catch (err) {
  console.error("[apply-migration] FAILED — transaction rolled back");
  console.error(err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
