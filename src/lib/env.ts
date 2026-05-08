import "server-only";
import { z } from "zod";

/**
 * Validated environment surface. Imported by every module that needs config.
 * Boot fails loudly if anything required is missing.
 */
const envSchema = z.object({
  // Auth.js v5
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 chars"),
  AUTH_TRUST_HOST: z.coerce.boolean().default(true),

  // Entra OIDC — optional in Phase 1/2 (filled in Phase 3 once App Registration exists).
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z.string().url().optional(),

  // Database (Supabase Postgres)
  POSTGRES_URL: z.string().url("POSTGRES_URL must be a postgres connection URL"),
  POSTGRES_URL_NON_POOLING: z.string().url().optional(),

  // Vercel Blob
  BLOB_READ_WRITE_TOKEN: z.string().min(10).optional(),

  // App
  APP_NAME: z.string().default("MWG CRM"),

  // Phase 12 — Supabase Realtime. URL + publishable/anon key are
  // browser-exposed (NEXT_PUBLIC_*). JWT secret is server-only and mints
  // user JWTs that the realtime client uses to authenticate with the
  // Realtime broker. All three are optional during dev (a missing
  // secret just means realtime features are inert) — production must
  // have all three set or the JWT mint endpoint will fail.
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
  SUPABASE_JWT_SECRET: z.string().min(20).optional(),

  // Cron / scheduled jobs (Phase 3D, 3H)
  CRON_SECRET: z.string().min(20).optional(),
  ALLOWED_EMAIL_DOMAINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  DEFAULT_TIMEZONE: z.string().default("America/Chicago"),

  // Vercel-injected
  VERCEL_URL: z.string().optional(),
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // env.ts is loaded *before* logger.ts (which imports from here). We
  // can't import the structured logger without a cycle; emit to stderr
  // in the same JSON-line shape so the Vercel build log stays parseable.
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "ERROR",
      msg: "env.invalid",
      issues: parsed.error.flatten().fieldErrors,
    })}\n`,
  );
  throw new Error("Invalid environment variables — see logs above");
}

export const env = parsed.data;

/** True when both Entra client ID and secret are present (Phase 3 complete). */
export const entraConfigured =
  Boolean(env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
  Boolean(env.AUTH_MICROSOFT_ENTRA_ID_SECRET) &&
  Boolean(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER);

/** Tenant ID baked into the issuer URL (used in error messages and dev tooling). */
export const MWG_TENANT_ID = "ae128315-4515-4382-89e8-094e98d313bc";
