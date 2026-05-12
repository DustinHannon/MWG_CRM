"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, RefreshCw, AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  markServiceConfirmedAction,
  runAllVerificationChecksAction,
  runVerificationCheckAction,
} from "./actions";

interface DomainStatusRow {
  id: string;
  serviceName: string;
  configuredUrl: string | null;
  expectedUrl: string;
  lastCheckedAtIso: string | null;
  status: "pending" | "verified" | "failed";
  errorDetail: Record<string, unknown> | null;
  manuallyConfirmedById: string | null;
  manuallyConfirmedAtIso: string | null;
}

interface Props {
  rows: DomainStatusRow[];
}

const SERVICE_LABELS: Record<string, string> = {
  vercel_production_domain: "Vercel — production domain",
  dns_godaddy_cname: "GoDaddy DNS — CNAME record",
  supabase_site_url: "Supabase — Site URL",
  supabase_redirect_urls: "Supabase — Redirect URLs",
  sendgrid_event_webhook: "SendGrid — Event Webhook Post URL",
  microsoft_entra_oauth_redirect: "Microsoft Entra — OAuth Redirect URI",
  betterstack_http_source: "Better Stack — HTTP source",
  unlayer_config: "Unlayer — editor config",
  clickdimensions_migration_script_env: "AZ-UTIL-AICHAT — CD migration script .env",
  deskpro_sync_config: "DeskPro — sync configuration",
};

export function DomainStatusClient({ rows }: Props) {
  const [pending, startTransition] = useTransition();
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const verifiedCount = rows.filter((r) => r.status === "verified").length;
  const total = rows.length;

  const runOne = (serviceName: string) => {
    setBusyRow(serviceName);
    const fd = new FormData();
    fd.set("serviceName", serviceName);
    startTransition(async () => {
      await runVerificationCheckAction(fd);
      setBusyRow(null);
    });
  };

  const runAll = () => {
    setBusyRow("__all__");
    startTransition(async () => {
      await runAllVerificationChecksAction();
      setBusyRow(null);
    });
  };

  const confirmManual = (serviceName: string) => {
    setBusyRow(serviceName);
    const fd = new FormData();
    fd.set("serviceName", serviceName);
    startTransition(async () => {
      await markServiceConfirmedAction(fd);
      setBusyRow(null);
    });
  };

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Domain status</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            External service URL configuration tracker for the
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">
              crm.morganwhite.com
            </code>
            migration.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {verifiedCount} / {total} verified
          </span>
          <button
            type="button"
            onClick={runAll}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn("h-4 w-4", pending && busyRow === "__all__" && "animate-spin")} />
            Run all checks
          </button>
        </div>
      </header>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Expected URL</th>
              <th className="px-3 py-2 font-medium">Configured URL</th>
              <th className="px-3 py-2 font-medium">Last checked</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const label = SERVICE_LABELS[row.serviceName] ?? row.serviceName;
              const rowBusy = pending && busyRow === row.serviceName;
              const lastChecked = row.lastCheckedAtIso
                ? new Date(row.lastCheckedAtIso).toLocaleString()
                : "—";
              return (
                <tr key={row.id} className="bg-background">
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{label}</div>
                    <div className="text-xs text-muted-foreground">{row.serviceName}</div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {row.expectedUrl}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {row.configuredUrl ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{lastChecked}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => runOne(row.serviceName)}
                        disabled={pending}
                        className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        {rowBusy ? "Checking…" : "Run check"}
                      </button>
                      <button
                        type="button"
                        onClick={() => confirmManual(row.serviceName)}
                        disabled={pending}
                        className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        Mark confirmed
                      </button>
                    </div>
                    {row.errorDetail && row.status === "failed" ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted-foreground">Detail</summary>
                        <pre className="mt-1 max-w-md overflow-x-auto rounded bg-muted p-2 text-[11px] text-muted-foreground">
                          {JSON.stringify(row.errorDetail, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: "pending" | "verified" | "failed" }) {
  if (status === "verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-won-bg)] px-2 py-0.5 text-xs font-medium text-[var(--status-won-fg)]">
        <CheckCircle2 className="h-3 w-3" />
        Verified
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-lost-bg)] px-2 py-0.5 text-xs font-medium text-[var(--status-lost-fg)]">
        <AlertTriangle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <Clock className="h-3 w-3" />
      Pending
    </span>
  );
}
