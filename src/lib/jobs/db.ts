import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import * as schema from "@/db/schema";

/**
 * Dedicated Postgres client for the durable job-queue worker ONLY.
 *
 * Why a second client (not `@/db`):
 *
 * The app's canonical client (`@/db`) runs on the Supavisor SESSION
 * pooler (`:5432`). postgres-js's extended-query protocol (every
 * parameterized Drizzle query) requires a backend pinned for the
 * connection lifetime — session mode provides that; the TRANSACTION
 * pooler (`:6543`) does NOT (it returns the backend after each
 * transaction), which wedges postgres-js at `ClientRead`. The app
 * therefore must stay on session mode.
 *
 * The job-queue worker fires every few minutes and, at the original
 * per-minute cadence, its claim transactions were exhausting the
 * shared session pool and starving request traffic — that pressure
 * is the only reason the transaction pooler was ever attempted.
 *
 * This client isolates the worker: its own postgres-js instance, its
 * own `max`, its own connection lifecycle, separate from the request
 * path. It reads `JOBS_DATABASE_URL` so the connection target is a
 * pure config decision:
 *   - default: POSTGRES_URL_NON_POOLING (Supavisor session pooler,
 *     IPv4, postgres-js-safe) — driver-level isolation, zero cost.
 *   - full isolation: set JOBS_DATABASE_URL to the true direct
 *     connection (db.<ref>.supabase.co:5432, requires the Supabase
 *     IPv4 add-on) so the worker bypasses Supavisor entirely and its
 *     connections never count against the app's session-pool budget.
 *     No code change — just the env value.
 *
 * Scope: imported only by `src/lib/jobs/*`. Nothing in the request
 * path uses this client.
 */
const url =
  env.JOBS_DATABASE_URL ?? env.POSTGRES_URL_NON_POOLING ?? env.POSTGRES_URL;

// Guard the resolved target against the two known misconfigurations the
// second client exists to avoid:
//   1. Falling through to POSTGRES_URL means neither JOBS_DATABASE_URL nor
//      POSTGRES_URL_NON_POOLING is set, so the worker shares the app's
//      session pool — the exact pool-starvation the module was built to
//      prevent. Warn loudly so it's visible in Better Stack; don't hard-fail
//      (a shared pool still works, it just reintroduces the pressure).
//   2. A :6543 target is the Supavisor TRANSACTION pooler, which wedges
//      postgres-js's extended-query protocol at ClientRead (two prior
//      production outages). That is never safe for this client, so fail fast.
if (url === env.POSTGRES_URL && !env.JOBS_DATABASE_URL && !env.POSTGRES_URL_NON_POOLING) {
  logger.warn("jobs.db.shared_app_pool", {
    errorMessage:
      "Job-queue worker is using POSTGRES_URL (app session pool): neither JOBS_DATABASE_URL nor POSTGRES_URL_NON_POOLING is set. Worker claim transactions count against the app's session-pool budget on every tick.",
  });
}
{
  // postgres:// URLs always carry an explicit host:port; URL parsing is
  // robust to query params and credentials. If it ever fails to parse we
  // leave the value untouched (postgres() will surface its own error).
  let port: string | undefined;
  try {
    port = new URL(url).port;
  } catch {
    port = undefined;
  }
  if (port === "6543") {
    throw new Error(
      "Job-queue worker DB URL targets the Supavisor transaction pooler (:6543), which wedges postgres-js at ClientRead. Point JOBS_DATABASE_URL/POSTGRES_URL_NON_POOLING at a session pooler (:5432) or the direct connection.",
    );
  }
}

const client = postgres(url, {
  // Session-mode / direct connections support prepared statements, but
  // keep prepare:false for parity with @/db and so a future repoint at
  // any pooler stays safe. fetch_types:false avoids the startup
  // pg_catalog round trip.
  prepare: false,
  fetch_types: false,
  // The worker awaits sweep -> claim -> dispatch -> mark in strict
  // order (see process-jobs route), so it never issues concurrent
  // queries on this client. max:1 provably bounds each Lambda to one
  // direct-connection backend, matches @/db, and preserves the
  // direct-connection ceiling if a */5 cron tick overlaps a prior
  // long-running tick (worker max runtime is 4 min).
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: "require",
  // application_name distinguishes the worker (direct connection)
  // from the app (Supavisor session pool) in pg_stat_activity, so
  // pool pressure can be diagnosed from the Supabase dashboard alone.
  // search_path: pg_trgm + unaccent live in the `extensions` schema.
  connection: {
    application_name: "mwg-crm-job-worker",
    search_path: "public, extensions",
  },
});

export const jobsDb = drizzle(client, { schema });
export { client as jobsSqlClient };
export type JobsDB = typeof jobsDb;
