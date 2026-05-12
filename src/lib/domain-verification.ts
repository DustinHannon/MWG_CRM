import "server-only";

import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { domainVerificationStatus } from "@/db/schema/domain-verification";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface DomainVerificationRow {
  id: string;
  serviceName: string;
  configuredUrl: string | null;
  expectedUrl: string;
  lastCheckedAt: Date | null;
  status: "pending" | "verified" | "failed";
  errorDetail: Record<string, unknown> | null;
  manuallyConfirmedById: string | null;
  manuallyConfirmedAt: Date | null;
  updatedAt: Date;
}

export async function listVerificationStatus(): Promise<DomainVerificationRow[]> {
  const rows = await db
    .select()
    .from(domainVerificationStatus)
    .orderBy(desc(domainVerificationStatus.serviceName));
  return rows.map((r) => ({
    id: r.id,
    serviceName: r.serviceName,
    configuredUrl: r.configuredUrl,
    expectedUrl: r.expectedUrl,
    lastCheckedAt: r.lastCheckedAt,
    status: r.status as "pending" | "verified" | "failed",
    errorDetail: r.errorDetail as Record<string, unknown> | null,
    manuallyConfirmedById: r.manuallyConfirmedById,
    manuallyConfirmedAt: r.manuallyConfirmedAt,
    updatedAt: r.updatedAt,
  }));
}

export async function recordVerificationResult(
  serviceName: string,
  result: {
    configuredUrl: string | null;
    status: "verified" | "failed";
    errorDetail?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db
    .update(domainVerificationStatus)
    .set({
      configuredUrl: result.configuredUrl,
      status: result.status,
      errorDetail: result.errorDetail ?? null,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(domainVerificationStatus.serviceName, serviceName));
}

export async function recordManualConfirmation(
  serviceName: string,
  userId: string,
): Promise<void> {
  await db
    .update(domainVerificationStatus)
    .set({
      status: "verified",
      manuallyConfirmedById: userId,
      manuallyConfirmedAt: new Date(),
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(domainVerificationStatus.serviceName, serviceName));
}

/**
 * Per-service automatic verification. Services without an API check
 * return { kind: "manual_only" } — the dashboard prompts for explicit
 * confirmation. API-checkable services return { kind: "checked" } with
 * the observed value and a verified/failed flag.
 */
export interface AutoCheckResult {
  kind: "checked" | "manual_only";
  configuredUrl: string | null;
  status: "verified" | "failed";
  errorDetail?: Record<string, unknown> | null;
}

export async function autoCheckService(
  serviceName: string,
): Promise<AutoCheckResult> {
  switch (serviceName) {
    case "vercel_production_domain":
      return checkVercelProductionDomain();
    case "sendgrid_event_webhook":
      return checkSendgridEventWebhook();
    case "dns_godaddy_cname":
      return checkCanonicalDnsResolves();
    default:
      return {
        kind: "manual_only",
        configuredUrl: null,
        status: "failed",
        errorDetail: { reason: "no_api_check_available" },
      };
  }
}

async function checkVercelProductionDomain(): Promise<AutoCheckResult> {
  const token = env.VERCEL_API_TOKEN;
  const teamId = env.VERCEL_TEAM_ID;
  const projectId = env.VERCEL_PROJECT_ID;
  if (!token || !projectId) {
    return {
      kind: "manual_only",
      configuredUrl: null,
      status: "failed",
      errorDetail: { reason: "vercel_api_creds_missing" },
    };
  }
  try {
    const url = new URL(`https://api.vercel.com/v9/projects/${projectId}`);
    if (teamId) url.searchParams.set("teamId", teamId);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        kind: "checked",
        configuredUrl: null,
        status: "failed",
        errorDetail: { httpStatus: res.status },
      };
    }
    const data = (await res.json()) as {
      alias?: Array<{ domain: string; productionDeployment?: boolean }>;
      targets?: { production?: { alias?: string[] } };
    };
    const aliases = data.alias?.map((a) => a.domain) ?? [];
    const productionAliases = data.targets?.production?.alias ?? [];
    const allAliases = [...aliases, ...productionAliases];
    const expectedHost = env.NEXT_PUBLIC_CANONICAL_HOST;
    const found = allAliases.find((a) => a === expectedHost) ?? null;
    return {
      kind: "checked",
      configuredUrl: found ? `https://${found}` : allAliases[0] ? `https://${allAliases[0]}` : null,
      status: found ? "verified" : "failed",
      errorDetail: found
        ? null
        : { allAliases, expected: expectedHost },
    };
  } catch (err) {
    logger.warn("infra.domain.vercel_check_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "checked",
      configuredUrl: null,
      status: "failed",
      errorDetail: { reason: "exception" },
    };
  }
}

async function checkSendgridEventWebhook(): Promise<AutoCheckResult> {
  const apiKey = env.SENDGRID_API_KEY;
  if (!apiKey) {
    return {
      kind: "manual_only",
      configuredUrl: null,
      status: "failed",
      errorDetail: { reason: "sendgrid_api_key_missing" },
    };
  }
  try {
    const res = await fetch(
      "https://api.sendgrid.com/v3/user/webhooks/event/settings",
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      return {
        kind: "checked",
        configuredUrl: null,
        status: "failed",
        errorDetail: { httpStatus: res.status },
      };
    }
    const data = (await res.json()) as { url?: string; enabled?: boolean };
    const expected = `https://${env.NEXT_PUBLIC_CANONICAL_HOST}/api/v1/webhooks/sendgrid/events`;
    const matches = data.url === expected;
    return {
      kind: "checked",
      configuredUrl: data.url ?? null,
      status: matches ? "verified" : "failed",
      errorDetail: matches
        ? null
        : { observed: data.url, expected, enabled: data.enabled },
    };
  } catch (err) {
    logger.warn("infra.domain.sendgrid_check_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return {
      kind: "checked",
      configuredUrl: null,
      status: "failed",
      errorDetail: { reason: "exception" },
    };
  }
}

async function checkCanonicalDnsResolves(): Promise<AutoCheckResult> {
  // Hits the canonical host's /api/health from server-side so a 200
  // confirms DNS resolution, valid TLS, and proxy routing.
  const expected = env.NEXT_PUBLIC_CANONICAL_HOST;
  const url = `https://${expected}/api/health`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    return {
      kind: "checked",
      configuredUrl: url,
      status: res.ok ? "verified" : "failed",
      errorDetail: res.ok ? null : { httpStatus: res.status },
    };
  } catch (err) {
    return {
      kind: "checked",
      configuredUrl: null,
      status: "failed",
      errorDetail: {
        reason: "fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
