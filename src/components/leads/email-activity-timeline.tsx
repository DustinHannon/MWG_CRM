"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  ExternalLink,
  Mail,
  MailWarning,
  MousePointerClick,
} from "lucide-react";
import { UserTimeClient } from "@/components/ui/user-time-client";
import type { TimePrefs } from "@/lib/format-time";
import type { EmailActivityCampaignRollup } from "@/lib/leads/email-activity";

interface EmailActivityTimelineProps {
  data: EmailActivityCampaignRollup[];
  prefs: TimePrefs;
}

/**
 * Phase 21 — Lead-detail marketing email timeline.
 *
 * Renders one card per campaign that targeted this lead, sorted newest
 * first. Each card surfaces the per-recipient metrics rolled up by
 * `getEmailActivityForLead` and a collapsible click history.
 *
 * Empty state: "No marketing emails sent to this lead yet."
 */
export function EmailActivityTimeline({
  data,
  prefs,
}: EmailActivityTimelineProps) {
  if (data.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-muted/40 p-6 text-center">
        <Mail className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
        <p className="mt-2 text-sm font-medium text-foreground">
          No marketing emails sent to this lead yet.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Once this lead is included in a campaign send, opens and clicks
          will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {data.map((row) => (
        <EmailActivityCard key={row.campaignId} row={row} prefs={prefs} />
      ))}
    </div>
  );
}

function EmailActivityCard({
  row,
  prefs,
}: {
  row: EmailActivityCampaignRollup;
  prefs: TimePrefs;
}) {
  const [showClicks, setShowClicks] = useState(false);
  const hasClicks = row.clicks.length > 0;
  const isBounced =
    row.status === "bounced" ||
    row.status === "blocked" ||
    row.status === "dropped";

  return (
    <article className="rounded-2xl border border-border bg-muted/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isBounced ? (
              <MailWarning
                className="h-4 w-4 shrink-0 text-[var(--status-lost-fg)]"
                aria-hidden
              />
            ) : (
              <Mail
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
            )}
            <Link
              href={`/marketing/campaigns/${row.campaignId}`}
              className="truncate text-sm font-medium text-foreground hover:underline"
              title={row.campaignName}
            >
              {row.campaignName}
            </Link>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {row.sentAt ? (
              <>
                Sent{" "}
                <UserTimeClient
                  value={row.sentAt}
                  prefs={prefs}
                  mode="date+time"
                />
              </>
            ) : (
              "Not yet sent"
            )}
          </p>
        </div>
        <Link
          href={`/marketing/campaigns/${row.campaignId}`}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
        >
          View campaign
          <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        <StatusBadge status={row.status} />
        {row.delivered ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--status-qualified-fg)]/30 bg-[var(--status-qualified-bg)] px-2 py-0.5 text-[var(--status-qualified-fg)]">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            Delivered
          </span>
        ) : null}
        {row.openCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--status-contacted-fg)]/30 bg-[var(--status-contacted-bg)] px-2 py-0.5 text-[var(--status-contacted-fg)]">
            Opened {row.openCount}×
            {row.firstOpenedAt ? (
              <span className="text-muted-foreground">
                {" · "}
                <UserTimeClient
                  value={row.firstOpenedAt}
                  prefs={prefs}
                  mode="date"
                />
              </span>
            ) : null}
          </span>
        ) : null}
        {row.clickCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--priority-high-fg)]/30 bg-[var(--priority-high-bg)] px-2 py-0.5 text-[var(--priority-high-fg)]">
            <MousePointerClick className="h-3 w-3" aria-hidden />
            {row.clickCount} click{row.clickCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      {hasClicks ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowClicks((s) => !s)}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            aria-expanded={showClicks}
          >
            {showClicks ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            )}
            {showClicks ? "Hide" : "Show"} click history (
            {row.clicks.length})
          </button>
          {showClicks ? (
            <ul className="mt-2 flex flex-col gap-1.5 rounded-lg border border-border bg-background/40 p-3 text-xs">
              {row.clicks.map((c, i) => (
                <li
                  key={`${c.url}-${i}`}
                  className="flex items-start justify-between gap-3"
                >
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-foreground hover:underline"
                    title={c.url}
                  >
                    {c.url}
                  </a>
                  <span className="shrink-0 text-muted-foreground">
                    <UserTimeClient
                      value={c.clickedAt}
                      prefs={prefs}
                      mode="date+time"
                    />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Reuse the existing status-pill aesthetic without coupling to its
  // CRM-status enum (recipient statuses are SendGrid-flavored).
  const tone = recipientStatusTone(status);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.05em] ${tone}`}
    >
      {status}
    </span>
  );
}

function recipientStatusTone(status: string): string {
  switch (status) {
    case "delivered":
    case "sent":
      return "border-[var(--status-qualified-fg)]/30 bg-[var(--status-qualified-bg)] text-[var(--status-qualified-fg)]";
    case "queued":
    case "deferred":
      return "border-[var(--status-new-fg)]/30 bg-[var(--status-new-bg)] text-[var(--status-new-fg)]";
    case "bounced":
    case "blocked":
    case "dropped":
    case "spamreport":
      return "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]";
    case "unsubscribed":
      return "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}
