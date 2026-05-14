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

  // Entra OIDC — optional /2 (filled once App Registration exists).
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z.string().url().optional(),

  // Microsoft Graph application permissions for system-originated
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

  // Supabase Realtime. URL + publishable/anon key are
  // browser-exposed (NEXT_PUBLIC_*). JWT secret is server-only and mints
  // user JWTs that the realtime client uses to authenticate with the
  // Realtime broker. All three are optional during dev (a missing
  // secret just means realtime features are inert) — production must
  // have all three set or the JWT mint endpoint will fail.
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
  SUPABASE_JWT_SECRET: z.string().min(20).optional(),

  // Cron / scheduled jobs (, 3H)
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

  // SendGrid marketing email. Optional in dev so a missing key
  // just disables marketing send paths (the UI shows a banner). Production
  // boot has all four set.
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_WEBHOOK_PUBLIC_KEY: z.string().optional(),
  SENDGRID_FROM_DOMAIN: z.string().default("morganwhite.com"),
  SENDGRID_FROM_NAME_DEFAULT: z.string().default("Morgan White Group"),
  // z.coerce.boolean() is a footgun: ANY non-empty string ("false", "0", "no")
  // coerces to true. Parse explicit truthy strings only so an accidentally-set
  // SENDGRID_SANDBOX="false" doesn't silently no-op every production send.
  SENDGRID_SANDBOX: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // ASM unsubscribe group used as asm.group_id for every marketing send.
  // Created via /v3/asm/groups; id is per-account.
  SENDGRID_UNSUBSCRIBE_GROUP_ID: z.coerce.number().int().optional(),

  // Unlayer (react-email-editor). Project id is a tenant
  // identifier and is exposed to the client; the API key is server-only
  // and only used for backend export-to-html fallback.
  UNLAYER_PROJECT_ID: z.coerce.number().int().optional(),
  NEXT_PUBLIC_UNLAYER_PROJECT_ID: z.coerce.number().int().optional(),
  UNLAYER_API_KEY: z.string().optional(),

  // Template soft-lock for collaborative editing.
  MARKETING_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  MARKETING_LOCK_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(30),

  // Security hardening: rate-limit budgets and webhook
  // signature freshness window. All have safe defaults so a missing
  // value in development doesn't disable the limiter.
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  RATE_LIMIT_WEBHOOK_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  RATE_LIMIT_TEST_SEND_PER_USER_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .default(20),
  RATE_LIMIT_FILTER_PREVIEW_PER_USER_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  RATE_LIMIT_CAMPAIGN_SEND_PER_USER_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  // CSP violation report endpoint. Public endpoint;
  // browsers POST to /api/v1/security/csp-report whenever the CSP
  // blocks a resource. Bound the volume per source IP so a misbehaving
  // page or a hostile origin can't flood audit_log.
  RATE_LIMIT_CSP_REPORT_PER_IP_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  // Geo-blocking. Allowlist is a comma-separated list of
  // ISO 3166-1 alpha-2 country codes. Requests from any other country
  // are rewritten to /blocked with a 403 status by `src/proxy.ts`.
  // Default `US,JM,PR` matches the WAF rule documented in
  // docs/operations/geo-blocking.md — keep the two in sync.
  GEO_ALLOWED_COUNTRIES: z
    .string()
    .default("US,JM,PR")
    .transform((s) =>
      s
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  GEO_BLOCK_AUDIT_RATE_LIMIT_PER_IP_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .default(5),

  // Canonical hostname + legacy redirect target. `src/proxy.ts`
  // redirects any request whose `Host` header matches LEGACY_VERCEL_HOST
  // to the same path on NEXT_PUBLIC_CANONICAL_HOST with status 301. The
  // audit event `infra.domain.legacy_redirect_hit` is throttled with
  // GEO_BLOCK_AUDIT_RATE_LIMIT_PER_IP_PER_HOUR.
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url()
    .default("https://crm.morganwhite.com"),
  NEXT_PUBLIC_CANONICAL_HOST: z.string().min(3).default("crm.morganwhite.com"),
  LEGACY_VERCEL_HOST: z.string().min(3).default("mwg-crm.vercel.app"),

  // / §5.2 — Better Stack SQL Query API. All optional so the
  // app still boots if a phase-26 prerequisite isn't provisioned yet;
  // the /admin/insights and /admin/server-logs pages render an empty
  // state via StandardEmptyState when any of these is missing.
  BETTERSTACK_SOURCE_ID: z.string().optional(),
  BETTERSTACK_TEAM_ID: z.string().optional(),
  BETTERSTACK_QUERY_HOST: z.string().optional(),
  BETTERSTACK_QUERY_USERNAME: z.string().optional(),
  BETTERSTACK_QUERY_PASSWORD: z.string().optional(),

  // Vercel REST API token for the recent-deployments
  // panel on /admin/insights. Optional for the same reason.
  VERCEL_API_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),

  // + §5.5 — server-side cache TTLs (seconds) for the two
  // admin observability pages.
  INSIGHTS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  SERVER_LOGS_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
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

/** True when both Entra client ID and secret are present (complete). */
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
