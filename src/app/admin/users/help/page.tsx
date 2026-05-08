import Link from "next/link";
import { GlassCard } from "@/components/ui/glass-card";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * Phase 9C — `/admin/users/help`. Admin-only static reference page that
 * documents every permission flag's effect. Linked from the admin Users
 * list header so admins can answer "what does this toggle do?" without
 * spelunking through code.
 *
 * Source of truth: docs/phases/reports/PHASE9-PERMISSIONS-AUDIT.md (Sub-agent C task list,
 * item 3 table). When new flags are added, update both this page AND
 * the audit doc.
 */
export default async function UsersHelpPage() {
  await requireAdmin();

  return (
    <div className="px-10 py-10">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/admin/users" className="hover:underline">
          Users
        </Link>
        <span aria-hidden>›</span>
        <span>Permission help</span>
      </div>
      <h1 className="text-2xl font-semibold">Permission help</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
        What every flag on the user permissions card actually does. Admins
        bypass every flag listed below — toggling a flag on an admin has
        no effect because <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">isAdmin</code>{" "}
        short-circuits each gate.
      </p>

      <GlassCard className="mt-8 overflow-hidden p-0">
        <table className="data-table min-w-full divide-y divide-border/60">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Flag</th>
              <th className="px-5 py-3 font-medium">What it does</th>
              <th className="px-5 py-3 font-medium">Default</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60 text-sm">
            <FlagRow
              flag="canViewAllRecords"
              effect={
                <>
                  See leads / accounts / contacts / opportunities owned by
                  other users. Bypasses owner scope on every list and
                  detail page, plus the dashboard{"’"}s &ldquo;Top owners&rdquo; chart and
                  the global search index.
                </>
              }
              defaultValue="OFF"
            />
            <FlagRow
              flag="canCreateLeads"
              effect={
                <>
                  Create new leads. Without it, the &ldquo;+ New&rdquo; button is
                  hidden and{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
                    createLeadAction
                  </code>{" "}
                  rejects.
                </>
              }
              defaultValue="ON"
            />
            <FlagRow
              flag="canEditLeads"
              effect={
                <>
                  Modify lead fields. Without it, the Edit button is hidden
                  and{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
                    updateLeadAction
                  </code>{" "}
                  rejects.
                </>
              }
              defaultValue="ON"
            />
            <FlagRow
              flag="canDeleteLeads"
              effect={
                <>
                  Archive leads. Without it, the Archive button is hidden
                  and{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
                    deleteLeadAction
                  </code>{" "}
                  rejects.
                </>
              }
              defaultValue="OFF"
            />
            <FlagRow
              flag="canImport"
              effect={
                <>
                  Use{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
                    /leads/import
                  </code>
                  . Without it, the Import button is hidden, the import
                  page redirects, and the import server actions reject.
                </>
              }
              defaultValue="OFF"
            />
            <FlagRow
              flag="canExport"
              effect={
                <>
                  Download filtered leads as XLSX. Without it, the Export
                  button is hidden and{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
                    /api/leads/export
                  </code>{" "}
                  rejects.
                </>
              }
              defaultValue="OFF"
            />
            <FlagRow
              flag="canSendEmail"
              effect={
                <>
                  Send email from the lead detail page using the user{"’"}s
                  Microsoft Graph token. Without it, the email send panel
                  is hidden and the send action rejects.
                </>
              }
              defaultValue="ON"
            />
            <FlagRow
              flag="canViewReports"
              effect={
                <>
                  Access{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
                    /dashboard
                  </code>{" "}
                  analytics. Without it, the Dashboard nav item is hidden
                  and the dashboard route redirects to{" "}
                  <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
                    /leads
                  </code>
                  .
                </>
              }
              defaultValue="ON"
            />
            <FlagRow
              flag="canViewTeamRecords"
              effect={
                <span className="italic text-muted-foreground">
                  Reserved — manager-linked record visibility ships in a
                  future phase. The schema column exists but no code reads
                  it yet, and it is intentionally not exposed in the admin
                  UI.
                </span>
              }
              defaultValue="OFF"
            />
            <tr className="text-sm">
              <td className="px-5 py-3 align-top">
                <span className="font-mono text-xs text-foreground">isAdmin</span>
                <span className="ml-2 inline-block rounded-full border border-blue-500/30 bg-blue-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-blue-700 dark:border-blue-300/30 dark:text-blue-100">
                  separate field
                </span>
              </td>
              <td className="px-5 py-3 text-foreground/90">
                Bypasses every flag above. Plus access to{" "}
                <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs">
                  /admin
                </code>
                . Toggling per-feature flags on an admin user has no
                visible effect.
              </td>
              <td className="px-5 py-3 align-top text-muted-foreground">OFF</td>
            </tr>
          </tbody>
        </table>
      </GlassCard>

      <p className="mt-6 max-w-3xl text-xs text-muted-foreground">
        The breakglass account always has every flag set to{" "}
        <code className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px]">
          true
        </code>{" "}
        and{" "}
        <code className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px]">
          isAdmin = true
        </code>{" "}
        — see{" "}
        <code className="rounded bg-muted/60 px-1.5 py-0.5 text-[11px]">
          src/lib/breakglass.ts
        </code>
        . That guarantees a recovery path even if every other admin is
        locked out.
      </p>
    </div>
  );
}

function FlagRow({
  flag,
  effect,
  defaultValue,
}: {
  flag: string;
  effect: React.ReactNode;
  defaultValue: "ON" | "OFF";
}) {
  return (
    <tr className="text-sm">
      <td className="whitespace-nowrap px-5 py-3 align-top font-mono text-xs text-foreground">
        {flag}
      </td>
      <td className="px-5 py-3 text-foreground/90">{effect}</td>
      <td className="px-5 py-3 align-top">
        <span
          className={
            defaultValue === "ON"
              ? "inline-block rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:border-emerald-300/30 dark:text-emerald-100"
              : "inline-block rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
          }
        >
          {defaultValue}
        </span>
      </td>
    </tr>
  );
}
