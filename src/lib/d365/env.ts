import "server-only";

/**
 * D365 environment configuration loader.
 *
 * Throws at first use if any required variable is missing. Optional
 * sizing variables fall back to brief-locked defaults.
 *
 * NOTE: Reads `process.env` directly rather than `@/lib/env` because
 * the central env module is loaded eagerly at boot, and these vars
 * are scoped to admin-only D365 routes — no need to fail the whole
 * app boot when D365 isn't configured locally.
 */
export interface D365Env {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  apiVersion: string;
  defaultPageSize: number;
  importBatchSize: number;
  timestampToleranceHours: number;
  /**
   * Q-05 fallback — when a D365 lead's owner cannot be resolved (no
   * Entra match, no JIT path), assign to this email's user.
   * Must be an existing mwg-crm user.
   */
  defaultOwnerEmail: string;
}

export function isD365Configured(): boolean {
  return Boolean(
    process.env.D365_TENANT_ID &&
      process.env.D365_CLIENT_ID &&
      process.env.D365_CLIENT_SECRET &&
      process.env.D365_BASE_URL,
  );
}

export function getD365Env(): D365Env {
  const tenantId = process.env.D365_TENANT_ID;
  const clientId = process.env.D365_CLIENT_ID;
  const clientSecret = process.env.D365_CLIENT_SECRET;
  const baseUrl = process.env.D365_BASE_URL;
  if (!tenantId || !clientId || !clientSecret || !baseUrl) {
    // invariant: bootstrap-time config failure — admin-only routes
    // gate on isD365Configured() before invoking, so reaching here
    // with a missing env is a deployment misconfiguration.
    throw new Error(
      "D365 environment variables not configured (need D365_TENANT_ID, D365_CLIENT_ID, D365_CLIENT_SECRET, D365_BASE_URL).",
    );
  }
  return {
    tenantId,
    clientId,
    clientSecret,
    baseUrl,
    apiVersion: process.env.D365_API_VERSION ?? "9.2",
    defaultPageSize: parsePositiveInt(process.env.D365_DEFAULT_PAGE_SIZE, 5000),
    importBatchSize: parsePositiveInt(process.env.D365_IMPORT_BATCH_SIZE, 100),
    timestampToleranceHours: parsePositiveInt(
      process.env.D365_TIMESTAMP_TOLERANCE_HOURS,
      24,
    ),
    defaultOwnerEmail: (
      process.env.D365_DEFAULT_OWNER_EMAIL ?? "dustin.hannon@morganwhite.com"
    )
      .trim()
      .toLowerCase(),
  };
}

function parsePositiveInt(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}
