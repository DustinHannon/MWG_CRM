import { and, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db";
import { auditLog } from "@/db/schema/audit";
import { StandardEmptyState } from "@/components/standard";
import {
  getErrorRateIssues,
  type IssueEntry,
} from "@/lib/observability/insights-queries";
import {
  isVercelApiConfigured,
  listRecentDeployments,
} from "@/lib/observability/vercel-api";
import { logger } from "@/lib/logger";

/**
 * issues banner.
 *
 * Aggregates issues from three sources:
 * 1. Better Stack error-rate spike check (last hour vs 7d baseline).
 * 2. Audit log WAF/geo-block surge (events with
 * action='geo.block.middleware_enforced' > 5x per-hour baseline).
 * 3. Vercel deployments — failed deploy in last hour = critical;
 * successful deploy in last hour = info.
 *
 * If nothing fires the banner renders a "no active issues" empty state.
 */
export async function IssuesBanner() {
  const issues: IssueEntry[] = [];

  // 1. Better Stack error-rate detection (graceful failure).
  try {
    issues.push(...(await getErrorRateIssues()));
  } catch (err) {
    logger.warn("insights.issues_banner.error_rate_failed", {
      message: (err as Error).message,
    });
  }

  // 2. WAF geo-block surge. Uses audit_log directly because the proxy
  // geo-block events flow through writeSystemAudit → audit_log.
  try {
    issues.push(...(await detectWafSurge()));
  } catch (err) {
    logger.warn("insights.issues_banner.waf_check_failed", {
      message: (err as Error).message,
    });
  }

  // 3. Deployment health from Vercel REST API.
  if (isVercelApiConfigured()) {
    try {
      const deployments = await listRecentDeployments({ limit: 5 });
      const oneHourAgo = new Date().getTime() - 60 * 60 * 1000;
      const recent = deployments.filter((d) => d.createdAt >= oneHourAgo);
      const failed = recent.find((d) => d.state === "ERROR");
      const succeeded = recent.find((d) => d.state === "READY");
      if (failed) {
        const sha = failed.meta?.githubCommitSha?.slice(0, 7) ?? failed.uid;
        issues.push({
          severity: "critical",
          title: "Failed deployment in last hour",
          description: `${sha} on ${failed.meta?.githubCommitRef ?? "unknown branch"} failed to build.`,
        });
      } else if (succeeded) {
        const sha = succeeded.meta?.githubCommitSha?.slice(0, 7) ?? succeeded.uid;
        issues.push({
          severity: "info",
          title: "Successful deployment in last hour",
          description: `${sha} on ${succeeded.meta?.githubCommitRef ?? "unknown branch"} is live.`,
        });
      }
    } catch (err) {
      logger.warn("insights.issues_banner.vercel_failed", {
        message: (err as Error).message,
      });
    }
  }

  return (
    <section aria-label="Active issues">
      <h2 className="mb-3 text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Active issues
      </h2>
      {issues.length === 0 ? (
        <StandardEmptyState
          variant="muted"
          title="No active issues"
          description="Platform healthy."
        />
      ) : (
        <div className="space-y-2">
          {issues.map((iss, idx) => (
            <IssueRow key={`${iss.severity}-${idx}`} issue={iss} />
          ))}
        </div>
      )}
    </section>
  );
}

function IssueRow({ issue }: { issue: IssueEntry }) {
  const classes =
    issue.severity === "critical"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : issue.severity === "warning"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-border bg-muted text-muted-foreground";
  return (
    <div className={`rounded-md border px-4 py-3 ${classes}`}>
      <p className="text-sm font-semibold">{issue.title}</p>
      <p className="mt-1 text-xs opacity-90">{issue.description}</p>
    </div>
  );
}

/**
 * Compare the count of `geo.block.middleware_enforced` events in the
 * last hour against the rolling 7-day per-hour average. Fires a
 * warning when the last hour exceeds 5x the baseline AND the last
 * hour has at least 5 events (to suppress noise on very-low-traffic
 * sites).
 */
async function detectWafSurge(): Promise<IssueEntry[]> {
  const nowMs = new Date().getTime();
  const oneHourAgo = new Date(nowMs - 60 * 60 * 1000);
  const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      lastHour: sql<number>`count(*) FILTER (WHERE ${auditLog.createdAt} >= ${oneHourAgo})`,
      sevenDay: sql<number>`count(*)`,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "geo.block.middleware_enforced"),
        gte(auditLog.createdAt, sevenDaysAgo),
      ),
    );

  const row = rows[0];
  if (!row) return [];
  const lastHour = Number(row.lastHour ?? 0);
  const sevenDay = Number(row.sevenDay ?? 0);
  // Per-hour baseline over the prior 7 days = 168 hours.
  const perHourBaseline = (sevenDay - lastHour) / 168;
  if (lastHour >= 5 && perHourBaseline > 0 && lastHour > perHourBaseline * 5) {
    return [
      {
        severity: "warning",
        title: "WAF geo-block surge",
        description: `${lastHour} blocked requests in the last hour (baseline ${perHourBaseline.toFixed(1)}/hr).`,
      },
    ];
  }
  return [];
}
