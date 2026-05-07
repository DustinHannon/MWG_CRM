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
  // Surface postgres notice / error context in logs so we can see what's
  // actually wrong instead of a Drizzle "Failed query" wrapper.
  onnotice: (n) =>
    console.warn(
      `[postgres] ${n.severity ?? "NOTICE"}: ${n.message ?? ""}`,
    ),
});

export const db = drizzle(client, { schema });
export type DB = typeof db;
