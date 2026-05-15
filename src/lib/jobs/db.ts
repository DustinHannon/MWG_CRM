import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";

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

const client = postgres(url, {
  // Session-mode / direct connections support prepared statements, but
  // keep prepare:false for parity with @/db and so a future repoint at
  // any pooler stays safe. fetch_types:false avoids the startup
  // pg_catalog round trip.
  prepare: false,
  fetch_types: false,
  // The worker claims in batches and may run a short pipeline of
  // state-transition statements per tick; a tiny pool (not max:1)
  // lets sweep + claim + mark overlap without head-of-line blocking,
  // while staying well within any connection budget.
  max: 3,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: "require",
  connection: { search_path: "public, extensions" },
});

export const jobsDb = drizzle(client, { schema });
export { client as jobsSqlClient };
export type JobsDB = typeof jobsDb;
