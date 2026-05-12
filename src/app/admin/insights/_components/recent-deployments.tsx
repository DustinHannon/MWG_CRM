import { ExternalLink } from "lucide-react";

import { StandardEmptyState } from "@/components/standard";
import {
  isVercelApiConfigured,
  listRecentDeployments,
  VercelNotConfiguredError,
  type VercelDeployment,
} from "@/lib/observability/vercel-api";

/**
 * last 5 Vercel deployments.
 *
 * Pulls from the Vercel REST API via the foundation helper. Each row
 * shows commit message, branch, state pill, build duration, and a
 * click-through to the deployment on vercel.com.
 *
 * Failure modes:
 * `VercelNotConfiguredError` → render "not configured" empty state.
 * Other errors → render a generic error empty state with the
 * message (admin-only page, so leaking the error is fine).
 */
const NOT_CONFIGURED_TITLE = "Vercel API not configured";
const NOT_CONFIGURED_DESC =
  "Set VERCEL_API_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID env vars to populate this panel.";

export async function RecentDeployments() {
  if (!isVercelApiConfigured()) {
    return (
      <Section>
        <StandardEmptyState
          variant="muted"
          title={NOT_CONFIGURED_TITLE}
          description={NOT_CONFIGURED_DESC}
        />
      </Section>
    );
  }

  let deployments: VercelDeployment[];
  try {
    deployments = await listRecentDeployments({ limit: 5 });
  } catch (err) {
    if (err instanceof VercelNotConfiguredError) {
      return (
        <Section>
          <StandardEmptyState
            variant="muted"
            title={NOT_CONFIGURED_TITLE}
            description={NOT_CONFIGURED_DESC}
          />
        </Section>
      );
    }
    return (
      <Section>
        <StandardEmptyState
          variant="card"
          title="Unable to load deployments"
          description={(err as Error).message}
        />
      </Section>
    );
  }

  if (deployments.length === 0) {
    return (
      <Section>
        <StandardEmptyState
          variant="muted"
          title="No recent deployments"
          description="Push to master to trigger a deployment."
        />
      </Section>
    );
  }

  // Capture the wall-clock once for stable relative-time rendering.
  const nowMs = new Date().getTime();

  return (
    <Section>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Commit</th>
              <th className="px-4 py-2 font-medium">Branch</th>
              <th className="px-4 py-2 font-medium">State</th>
              <th className="px-4 py-2 text-right font-medium">Build</th>
              <th className="px-4 py-2 text-right font-medium">Created</th>
              <th className="w-8 px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {deployments.map((d) => (
              <DeploymentRow key={d.uid} d={d} nowMs={nowMs} />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section aria-label="Recent deployments" className="space-y-2">
      <h2 className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Recent deployments
      </h2>
      {children}
    </section>
  );
}

function DeploymentRow({ d, nowMs }: { d: VercelDeployment; nowMs: number }) {
  const commit = (d.meta?.githubCommitMessage ?? "(no commit message)").slice(
    0,
    60,
  );
  const branch = d.meta?.githubCommitRef ?? "—";
  const buildDuration =
    d.ready && d.buildingAt
      ? `${Math.round((d.ready - d.buildingAt) / 1000)}s`
      : "—";
  const href = `https://vercel.com/one-man/mwg-crm/deployments/${d.uid}`;
  return (
    <tr>
      <td className="truncate px-4 py-2 text-foreground">{commit}</td>
      <td className="truncate px-4 py-2 font-mono text-xs text-muted-foreground">
        {branch}
      </td>
      <td className="px-4 py-2">
        <DeploymentStatePill state={d.state} />
      </td>
      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
        {buildDuration}
      </td>
      <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
        {relativeTime(d.createdAt, nowMs)}
      </td>
      <td className="px-4 py-2">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label="Open deployment in Vercel"
        >
          <ExternalLink
            aria-hidden="true"
            className="h-3.5 w-3.5"
            strokeWidth={1.5}
          />
        </a>
      </td>
    </tr>
  );
}

function DeploymentStatePill({ state }: { state: VercelDeployment["state"] }) {
  const cls =
    state === "READY"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : state === "ERROR"
        ? "bg-destructive/10 text-destructive"
        : state === "BUILDING" || state === "QUEUED" || state === "INITIALIZING"
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {state}
    </span>
  );
}

function relativeTime(epochMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - epochMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
