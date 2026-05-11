import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Postgres client (postgres-js).
 *
 * Tuning notes — these matter on Vercel + Supabase Supavisor:
 *
 * - `prepare: false` — Supavisor (any pool mode) does not support
 *   prepared statement caching across pooled connections. Required.
 *
 * - `max: 1` — Supavisor IS the pool. Each Lambda invocation just needs
 *   ONE connection through it. Setting max higher (we had 10 in Phase 1)
 *   produces stale-connection issues across Lambda warm-starts in
 *   drizzle-orm ≥0.45 — manifests as intermittent "Failed query"
 *   errors that succeed on retry. Reference: Supabase + Vercel
 *   integration recommendation.
 *
 * - `idle_timeout: 20` — close idle connections after 20s; keeps the
 *   pool from hoarding connections during quiet periods.
 *
 * - `connect_timeout: 10` — fail fast if Supavisor is having a moment
 *   instead of hanging the Lambda all the way to its 60s wall.
 */
const client = postgres(env.POSTGRES_URL, {
  prepare: false,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: "require",
  // Phase 25 §6.5 — pg_trgm + unaccent moved from `public` to a
  // dedicated `extensions` schema. The mwg_crm_app role's default
  // search_path was updated server-side, but pooled connections that
  // existed before that ALTER ROLE landed kept the stale path until
  // recycle. Setting search_path explicitly on every new postgres-js
  // connection eliminates that staleness — the parameter is sent in
  // the StartupMessage so it applies to every session immediately.
  connection: { search_path: "public, extensions" },
  // Surface postgres notice / error context in logs so we can see what's
  // actually wrong instead of a Drizzle "Failed query" wrapper.
  onnotice: (n) => {
    // postgres-js calls this synchronously during driver setup. We can't
    // import the structured logger here without a circular dependency
    // through env.ts; route to stderr in JSON line format directly.
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "WARN",
        msg: "postgres.notice",
        severity: n.severity ?? "NOTICE",
        detail: n.message ?? "",
      })}\n`,
    );
  },
});

export const db = drizzle(client, { schema });
export type DB = typeof db;

/**
 * Phase 11 — raw postgres-js tag for callers that need to compose SQL
 * with dynamically-validated identifiers (e.g., the Reports feature's
 * executeReport, which can't use Drizzle's typed query builder because
 * the column list is determined at runtime). Use sparingly: every
 * caller MUST validate identifiers against an allowlist before
 * interpolation. For typed queries, prefer `db`.
 */
export { client as sqlClient };
