// Diagnostic: snapshot of active Supabase/Postgres sessions. Surfaces
// per-application_name + per-state counts so we can see what's holding
// connections during a pool-exhaustion incident.
//
// Usage:
//   pnpm dlx tsx --env-file .env.local scripts/diag-connections.mjs

import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("POSTGRES_URL not set");
  process.exit(1);
}

const client = postgres(url, {
  prepare: false,
  max: 1,
  ssl: "require",
  connection: { search_path: "public, extensions" },
});

try {
  const rows = await client`
    SELECT
      application_name,
      usename,
      state,
      count(*)::int AS sessions,
      max(now() - state_change) AS oldest_in_state,
      max(now() - query_start) AS oldest_query_age
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
    GROUP BY application_name, usename, state
    ORDER BY sessions DESC, oldest_in_state DESC NULLS LAST
  `;
  console.log("=== Active Postgres sessions ===");
  console.log(`Total non-self sessions: ${rows.reduce((n, r) => n + r.sessions, 0)}`);
  console.log("");
  for (const r of rows) {
    console.log(
      `${String(r.sessions).padStart(3)} × ${r.state ?? "(null)"}` +
        ` | app="${r.application_name}" user="${r.usename}"` +
        ` | oldest_in_state=${r.oldest_in_state ?? "-"}` +
        ` | oldest_query_age=${r.oldest_query_age ?? "-"}`,
    );
  }

  // Long-running idle-in-transaction is the classic leak signal.
  const stuck = await client`
    SELECT
      application_name,
      pid,
      state,
      now() - xact_start AS xact_age,
      now() - query_start AS query_age,
      left(query, 200) AS query
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state IN ('idle in transaction', 'idle in transaction (aborted)')
    ORDER BY xact_age DESC NULLS LAST
    LIMIT 10
  `;
  if (stuck.length > 0) {
    console.log("");
    console.log("=== Idle-in-transaction sessions (potential leaks) ===");
    for (const s of stuck) {
      console.log(
        `pid=${s.pid} state=${s.state} app=${s.application_name}` +
          ` xact_age=${s.xact_age} query_age=${s.query_age}`,
      );
      console.log(`  query: ${s.query}`);
    }
  } else {
    console.log("");
    console.log("No idle-in-transaction sessions. ✅");
  }
} catch (err) {
  console.error("Diag failed:", err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
