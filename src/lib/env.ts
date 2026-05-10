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

  // Phase 15 — Microsoft Graph application permissions for system-originated
  // email (sendEmailAs / preflight). New aliases default to the existing
  // delegated-flow values so the same Entra app works for both flows once
  // Mail.Send + User.Read.All application permissions are admin-consented.
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  EMAIL_SYSTEM_FROM_USER_ID: z.string().optional(),

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

  // Phase 19 — SendGrid marketing email. Optional in dev so a missing key
  // just disables marketing send paths (the UI shows a banner). Production
  // boot has all four set.
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  SENDGRID_FROM_DOMAIN: z.string().default("morganwhite.com"),
  SENDGRID_FROM_NAME_DEFAULT: z.string().default("Morgan White Group"),
  SENDGRID_SANDBOX: z.coerce.boolean().default(false),
  // ASM unsubscribe group used as asm.group_id for every marketing send.
  // Created via /v3/asm/groups; id is per-account.
  SENDGRID_UNSUBSCRIBE_GROUP_ID: z.coerce.number().int().optional(),

  // Phase 19 — Unlayer (react-email-editor). Project id is a tenant
  // identifier and is exposed to the client; the API key is server-only
  // and only used for backend export-to-html fallback.
  UNLAYER_PROJECT_ID: z.coerce.number().int().optional(),
  NEXT_PUBLIC_UNLAYER_PROJECT_ID: z.coerce.number().int().optional(),
  UNLAYER_API_KEY: z.string().optional(),

  // Phase 19 — Template soft-lock for collaborative editing.
  MARKETING_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  MARKETING_LOCK_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(30),
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

/** True when the SendGrid marketing pipeline has every key it needs. */
export const sendgridConfigured =
  Boolean(env.SENDGRID_API_KEY) &&
  Boolean(env.SENDGRID_WEBHOOK_PUBLIC_KEY) &&
  Boolean(env.SENDGRID_UNSUBSCRIBE_GROUP_ID);

/** True when Unlayer is configured for client-side embedding. */
export const unlayerConfigured = Boolean(env.NEXT_PUBLIC_UNLAYER_PROJECT_ID);
