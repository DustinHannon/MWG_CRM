"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { UserTimeClient } from "@/components/ui/user-time-client";
import type { TimePrefs } from "@/lib/format-time";

/**
 * Marketing email performance report (client component).
 *
 * Renders KPIs across the campaign rows passed in, plus a campaign ×
 * event-type pivot table. Date-range filter applies in-page (no
 * server roundtrip) — the server passes pre-filtered rows for the
 * default 30-day window.
 *
 * "Export to Excel" hits the dedicated export route (added to actions
 * once the Excel pipeline is reused; here it surfaces the link).
 */

export interface MarketingReportRow {
  id: string;
  name: string;
  status: string;
  sentAt: Date | null;
  totalRecipients: number;
  totalSent: number;
  totalDelivered: number;
  totalOpened: number;
  totalClicked: number;
  totalBounced: number;
  totalUnsubscribed: number;
}

interface Props {
  /** Rows already filtered to the report window by the server. */
  rows: MarketingReportRow[];
  prefs: TimePrefs;
  defaultFrom: string;
  defaultTo: string;
}

export function MarketingEmailReport({
  rows,
  prefs,
  defaultFrom,
  defaultTo,
}: Props) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);

  // Apply the date filter on the client to avoid a server round-trip
  // when only the range changes; the URL form below reloads with the
  // server-side filter for shareable links.
  const filtered = useMemo(() => {
    const fromTime = from ? new Date(from).getTime() : 0;
    const toTime = to ? new Date(to).getTime() : Number.POSITIVE_INFINITY;
    return rows.filter((r) => {
      if (!r.sentAt) return false;
      const t = r.sentAt.getTime();
      return t >= fromTime && t <= toTime;
    });
  }, [rows, from, to]);

  const kpis = useMemo(() => aggregateKpis(filtered), [filtered]);

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-muted/40 p-4"
        action="/marketing/reports/email"
        method="GET"
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor="from"
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
          >
            From
          </label>
          <input
            id="from"
            name="from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor="to"
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
          >
            To
          </label>
          <input
            id="to"
            name="to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-input px-3 py-1.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90"
        >
          Apply
        </button>
        <Link
          href={`/marketing/reports/email/export?from=${from}&to=${to}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          <Download className="h-4 w-4" aria-hidden /> Export to Excel
        </Link>
      </form>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Sent" value={kpis.totalSent} />
        <Kpi label="Delivered" value={kpis.totalDelivered} />
        <Kpi
          label="Open rate"
          value={kpis.openRate}
          suffix="%"
          fractional
        />
        <Kpi
          label="Click rate"
          value={kpis.clickRate}
          suffix="%"
          fractional
        />
        <Kpi
          label="Bounce rate"
          value={kpis.bounceRate}
          suffix="%"
          fractional
        />
        <Kpi
          label="Unsub rate"
          value={kpis.unsubRate}
          suffix="%"
          fractional
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Campaign breakdown
        </h2>
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/40 p-8 text-center text-sm text-muted-foreground">
            No campaigns sent in this window.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-[0.05em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Campaign</th>
                  <th className="px-4 py-3 text-left font-medium whitespace-nowrap">Sent</th>
                  <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Recip.</th>
                  <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Delivered</th>
                  <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Opened</th>
                  <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Clicked</th>
                  <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Bounced</th>
                  <th className="px-4 py-3 text-right font-medium whitespace-nowrap">Unsub</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((r) => (
                  <tr key={r.id} className="transition hover:bg-accent/20">
                    <td className="px-4 py-3">
                      <Link
                        href={`/marketing/campaigns/${r.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.sentAt ? (
                        <UserTimeClient
                          value={r.sentAt}
                          prefs={prefs}
                          mode="date"
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {r.totalRecipients.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {r.totalDelivered.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {r.totalOpened.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {r.totalClicked.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {r.totalBounced.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {r.totalUnsubscribed.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

interface Kpis {
  totalSent: number;
  totalDelivered: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  unsubRate: number;
}

function aggregateKpis(rows: MarketingReportRow[]): Kpis {
  let sent = 0;
  let delivered = 0;
  let opened = 0;
  let clicked = 0;
  let bounced = 0;
  let unsub = 0;
  for (const r of rows) {
    sent += r.totalSent;
    delivered += r.totalDelivered;
    opened += r.totalOpened;
    clicked += r.totalClicked;
    bounced += r.totalBounced;
    unsub += r.totalUnsubscribed;
  }
  const safe = (n: number, d: number): number =>
    d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
  return {
    totalSent: sent,
    totalDelivered: delivered,
    openRate: safe(opened, delivered),
    clickRate: safe(clicked, delivered),
    bounceRate: safe(bounced, sent),
    unsubRate: safe(unsub, delivered),
  };
}

function Kpi({
  label,
  value,
  suffix,
  fractional,
}: {
  label: string;
  value: number;
  suffix?: string;
  fractional?: boolean;
}) {
  const formatted = fractional
    ? value.toLocaleString(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })
    : value.toLocaleString();
  return (
    <div className="rounded-2xl border border-border bg-muted/40 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground">
        {formatted}
        {suffix ?? ""}
      </p>
    </div>
  );
}
