import "server-only";

import { unstable_cache } from "next/cache";

import { env } from "@/lib/env";
import { writeSystemAudit } from "@/lib/audit";

/**
 * Phase 26 §3.3 — Read-only Vercel REST API helper.
 *
 * Used by /admin/insights for the "Recent deployments" panel. Auth via
 * env.VERCEL_API_TOKEN; team + project scoped via env.VERCEL_TEAM_ID
 * + env.VERCEL_PROJECT_ID.
 *
 * Every call is wrapped in `unstable_cache` with the Insights page TTL
 * so we don't hammer the Vercel API. Manual refresh on the page calls
 * `revalidatePath('/admin/insights')` which invalidates this layer too.
 */

export interface VercelDeployment {
  uid: string;
  url: string;
  state: "READY" | "ERROR" | "BUILDING" | "QUEUED" | "CANCELED" | "INITIALIZING";
  createdAt: number;
  buildingAt?: number;
  ready?: number;
  meta?: {
    githubCommitMessage?: string;
    githubCommitRef?: string;
    githubCommitSha?: string;
    githubCommitAuthorName?: string;
  };
}

export class VercelNotConfiguredError extends Error {
  constructor() {
    super(
      "Vercel REST API is not configured (VERCEL_API_TOKEN / TEAM_ID / PROJECT_ID missing).",
    );
    this.name = "VercelNotConfiguredError";
  }
}

export class VercelApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "VercelApiError";
  }
}

export function isVercelApiConfigured(): boolean {
  return Boolean(
    env.VERCEL_API_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID,
  );
}

async function emitFailureAudit(
  url: string,
  kind: string,
  err: unknown,
): Promise<void> {
  try {
    await writeSystemAudit({
      actorEmailSnapshot: "system@observability",
      action: "observability.vercel_api.failed",
      targetType: "vercel_api",
      after: {
        kind,
        url: url.slice(0, 300),
        message: (err as Error)?.message?.slice(0, 500) ?? "unknown",
      },
    });
  } catch {
    // never block the caller on audit-emission failures
  }
}

async function vercelFetch<T>(path: string): Promise<T> {
  if (!isVercelApiConfigured()) {
    throw new VercelNotConfiguredError();
  }

  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.vercel.com${path}${sep}teamId=${env.VERCEL_TEAM_ID}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.VERCEL_API_TOKEN}` },
      cache: "no-store",
    });
  } catch (err) {
    await emitFailureAudit(url, "fetch_failed", err);
    throw new VercelApiError(
      `Vercel fetch failed: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    await emitFailureAudit(url, `http_${res.status}`, new Error(text));
    throw new VercelApiError(
      `Vercel ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

/** Fetch the most recent deployments for the project. */
export async function listRecentDeployments(
  opts: { limit?: number } = {},
): Promise<VercelDeployment[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));

  const fn = unstable_cache(
    async () => {
      const data = await vercelFetch<{ deployments: VercelDeployment[] }>(
        `/v6/deployments?projectId=${env.VERCEL_PROJECT_ID}&limit=${limit}`,
      );
      return data.deployments ?? [];
    },
    ["vercel-api", "recent-deployments", String(limit)],
    {
      revalidate: env.INSIGHTS_CACHE_TTL_SECONDS,
      tags: ["vercel-api"],
    },
  );

  return fn();
}
