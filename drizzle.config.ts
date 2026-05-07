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
} satisfies Config;
