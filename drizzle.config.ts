// We don't import dotenv here — drizzle-kit is invoked with the env populated
// from `vercel env pull` (.env.production.local) or by pnpm scripts that
// inline the var. Keeping this import-free avoids an extra dev dep.
import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit reads the *direct* (non-pooled) Postgres URL because some DDL
 * operations behave badly through the transaction-mode pooler. Application
 * runtime always uses POSTGRES_URL (pooled, port 6543) — see src/db/index.ts.
 */
export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL ?? "",
  },
  strict: true,
  verbose: true,
  // Belt-and-suspenders: explicitly point the (unused) migrations runner at a
  // sentinel table/schema name that doesn't exist. The deploy pipeline never
  // invokes drizzle-kit migrate; production migrations apply via Supabase
  // MCP `apply_migration` only. The drizzle journal (drizzle/meta/) is still
  // maintained as a drift-detection ledger so `pnpm db:generate` and
  // `pnpm db:check` continue to produce signal. See CLAUDE.md
  // "Database / migrations / Drizzle" for the canonical workflow.
  migrations: {
    table: "__drizzle_migrations__do_not_use",
    schema: "__drizzle_disabled__",
  },
} satisfies Config;
