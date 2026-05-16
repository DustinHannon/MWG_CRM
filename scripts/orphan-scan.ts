/**
 * scripts/orphan-scan.ts
 *
 * Reads every parent/child relationship in the DB and reports rows whose FK
 * target no longer exists. Expected to return all zeros — non-zero rows
 * indicate a missing CASCADE rule or a manual delete that bypassed Drizzle.
 *
 * Run: pnpm tsx scripts/orphan-scan.ts
 *
 * The script also lists Vercel Blob assets whose `attachments.blob_url` row
 * has been deleted. Set BLOB_READ_WRITE_TOKEN to enable that scan; otherwise
 * the DB-only checks still run.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db";

const SCANS: { rel: string; query: string }[] = [
  { rel: "lead_tags->leads",         query: `SELECT count(*)::int AS n FROM lead_tags lt LEFT JOIN leads l ON l.id = lt.lead_id WHERE l.id IS NULL` },
  { rel: "lead_tags->tags",          query: `SELECT count(*)::int AS n FROM lead_tags lt LEFT JOIN tags t ON t.id = lt.tag_id WHERE t.id IS NULL` },
  { rel: "activities->leads",        query: `SELECT count(*)::int AS n FROM activities a WHERE a.lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = a.lead_id)` },
  { rel: "activities->crm_accounts", query: `SELECT count(*)::int AS n FROM activities a WHERE a.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_accounts ca WHERE ca.id = a.account_id)` },
  { rel: "activities->contacts",     query: `SELECT count(*)::int AS n FROM activities a WHERE a.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = a.contact_id)` },
  { rel: "activities->opportunities",query: `SELECT count(*)::int AS n FROM activities a WHERE a.opportunity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.id = a.opportunity_id)` },
  { rel: "tasks->leads",             query: `SELECT count(*)::int AS n FROM tasks t WHERE t.lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = t.lead_id)` },
  { rel: "tasks->crm_accounts",      query: `SELECT count(*)::int AS n FROM tasks t WHERE t.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_accounts ca WHERE ca.id = t.account_id)` },
  { rel: "tasks->contacts",          query: `SELECT count(*)::int AS n FROM tasks t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id)` },
  { rel: "tasks->opportunities",     query: `SELECT count(*)::int AS n FROM tasks t WHERE t.opportunity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.id = t.opportunity_id)` },
  { rel: "attachments->activities",  query: `SELECT count(*)::int AS n FROM attachments a WHERE NOT EXISTS (SELECT 1 FROM activities ac WHERE ac.id = a.activity_id)` },
  { rel: "notifications->users",     query: `SELECT count(*)::int AS n FROM notifications n LEFT JOIN users u ON u.id = n.user_id WHERE u.id IS NULL` },
  { rel: "audit_log->users",         query: `SELECT count(*)::int AS n FROM audit_log al WHERE al.actor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = al.actor_id)` },
  { rel: "saved_views->users",       query: `SELECT count(*)::int AS n FROM saved_views sv LEFT JOIN users u ON u.id = sv.user_id WHERE u.id IS NULL` },
  { rel: "recent_views->users",      query: `SELECT count(*)::int AS n FROM recent_views rv LEFT JOIN users u ON u.id = rv.user_id WHERE u.id IS NULL` },
  { rel: "recent_views->entity",     query: `SELECT count(*)::int AS n FROM recent_views rv WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE rv.entity_type = 'lead' AND l.id = rv.entity_id UNION ALL SELECT 1 FROM contacts c WHERE rv.entity_type = 'contact' AND c.id = rv.entity_id UNION ALL SELECT 1 FROM crm_accounts a WHERE rv.entity_type = 'account' AND a.id = rv.entity_id UNION ALL SELECT 1 FROM opportunities o WHERE rv.entity_type = 'opportunity' AND o.id = rv.entity_id)` },
  { rel: "user_preferences->users",  query: `SELECT count(*)::int AS n FROM user_preferences up LEFT JOIN users u ON u.id = up.user_id WHERE u.id IS NULL` },
];

async function main() {
  let exitCode = 0;
  console.log("=== Orphan scan ===");
  for (const s of SCANS) {
    const rows = await db.execute<{ n: number }>(sql.raw(s.query));
    const n = Number(rows[0]?.n ?? 0);
    const status = n === 0 ? "OK " : "BAD";
    console.log(`[${status}] ${s.rel.padEnd(32)} ${n} orphan${n === 1 ? "" : "s"}`);
    if (n > 0) exitCode = 1;
  }

  // Vercel Blob orphan scan (DB rows whose blob is gone)
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    console.log("\n=== Vercel Blob orphan scan ===");
    const { list } = await import("@vercel/blob");
    const dbRows = await db.execute<{ blob_url: string }>(
      sql.raw(`SELECT blob_url FROM attachments WHERE blob_url IS NOT NULL`),
    );
    const dbUrls = new Set(dbRows.map((r) => r.blob_url));
    let cursor: string | undefined;
    let liveOrphans = 0;
    let dbOrphans = 0;
    const liveUrls = new Set<string>();
    do {
      const page = await list({ cursor, limit: 1000 });
      for (const b of page.blobs) {
        liveUrls.add(b.url);
        if (!dbUrls.has(b.url)) liveOrphans++;
      }
      cursor = page.cursor;
    } while (cursor);
    for (const u of dbUrls) {
      if (!liveUrls.has(u)) dbOrphans++;
    }
    console.log(`[${liveOrphans === 0 ? "OK " : "BAD"}] blob-store URLs not in DB:    ${liveOrphans}`);
    console.log(`[${dbOrphans === 0 ? "OK " : "BAD"}] attachments.blob_url not live:  ${dbOrphans}`);
    if (liveOrphans > 0 || dbOrphans > 0) exitCode = 1;
  } else {
    console.log("\nSkipping Blob scan (set BLOB_READ_WRITE_TOKEN to enable).");
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
