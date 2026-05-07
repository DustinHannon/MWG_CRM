import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Postgres client. `prepare: false` is REQUIRED for Supabase's transaction-mode
 * pooler (port 6543) — prepared statement state can't be cached across pooled
 * connections. See: https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pooler
 */
const client = postgres(env.POSTGRES_URL, {
  prepare: false,
  max: 10,
  idle_timeout: 20,
  ssl: "require",
});

export const db = drizzle(client, { schema });
export type DB = typeof db;
