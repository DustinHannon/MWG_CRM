// Phase 6I — admin-only static reference for the import pipeline.
// Linked from /admin and recommended in the import preview screen
// when smart-detect is enabled.

import Link from "next/link";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { TEMPLATE_HEADERS } from "@/lib/import/headers";
import { LEAD_RATINGS, LEAD_SOURCES, LEAD_STATUSES } from "@/lib/lead-constants";

export const dynamic = "force-dynamic";

export default function ImportHelpPage() {
  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Import help" },
        ]}
      />
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground/80">
        Admin
      </p>
      <h1 className="mt-1 text-2xl font-semibold">Import help</h1>
      <p className="mt-2 max-w-3xl text-sm text-foreground/80">
        Reference for the lead-import flow. The current template has 39
        columns; download it from{" "}
        <Link href="/leads/import" className="underline">
          /leads/import
        </Link>{" "}
        before exporting data out of another system.
      </p>

      <GlassCard className="mt-8 p-6">
        <h2 className="text-lg font-semibold">Columns</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          First Name is required. Every other column may be empty.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Header</th>
                <th className="px-3 py-2 text-left">Required</th>
                <th className="px-3 py-2 text-left">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 text-foreground/90">
              {TEMPLATE_HEADERS.map((h) => (
                <tr key={h.field}>
                  <td className="px-3 py-1.5 font-medium">{h.header}</td>
                  <td className="px-3 py-1.5">{h.required ? "Yes" : "No"}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{h.notes ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-lg font-semibold">Multi-line activity columns</h2>
        <p className="mt-2 text-sm text-foreground/80">
          Notes, Phone Calls, Meetings, and Emails are free-text columns
          where each activity starts on a new line beginning with a
          bracketed timestamp.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-black/30 p-3 text-[11px] leading-relaxed text-foreground/90">{`[2026-01-29 02:54 PM UTC] Dental Quote
  Outgoing | Duration: 30 min | By: Tanzania Griffith
  Lead called wanting BEST dental plan w/o copays.

[2026-02-15 10:30 AM CT] Follow-up
  Outgoing | Left Voicemail | By: Tanzania Griffith`}</pre>
        <ul className="mt-3 list-disc pl-6 text-sm text-foreground/80">
          <li>
            Calls metadata: <code>Outgoing | Duration: N min | By: Name</code>{" "}
            or with a non-duration outcome like{" "}
            <code>Left Voicemail</code>, <code>No Answer</code>,{" "}
            <code>Connected</code>.
          </li>
          <li>
            Meetings metadata:{" "}
            <code>
              Status: ... | End: ... | Duration: N min | Owner: Name
            </code>
            , then optionally{" "}
            <code>Attendees: A, B, C</code> on the next line.
          </li>
          <li>
            Notes inline form:{" "}
            <code>[timestamp] — by First Last body text</code>.
          </li>
          <li>
            Emails metadata: <code>From: a@x.com | To: b@y.com</code>.
          </li>
          <li>
            Cap of 200 most-recent activities per lead per import. Excess
            activities are silently truncated (preview shows a warning).
          </li>
        </ul>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-lg font-semibold">Smart-detect mode</h2>
        <p className="mt-2 text-sm text-foreground/80">
          For legacy D365 exports, the entire CRM history (Topic, Phone
          Calls, Notes, Meetings, Linked Opportunity, Description) often
          comes through in the Description column. Tick the
          smart-detect box on the upload screen to extract it
          automatically. New exports should populate the dedicated
          columns above instead.
        </p>
        <p className="mt-2 text-sm text-foreground/80">
          When smart-detect runs, the dedicated columns take precedence
          if both are populated — useful when partially migrating from
          legacy data.
        </p>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-lg font-semibold">Status / stage mappings</h2>
        <div className="mt-3 grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
              Lead status (D365 → MWG)
            </h3>
            <table className="mt-2 w-full text-xs">
              <tbody className="divide-y divide-border/60 text-foreground/90">
                {[
                  ["Open", "new"],
                  ["Attempting Contact", "contacted"],
                  ["Qualified", "qualified"],
                  ["Not Interested", "unqualified"],
                  ["No Response", "unqualified"],
                  ["Lost", "lost"],
                ].map(([from, to]) => (
                  <tr key={from}>
                    <td className="py-1 pr-3">{from}</td>
                    <td className="py-1 pr-3 text-muted-foreground/80">→</td>
                    <td className="py-1 font-medium">{to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
              Opportunity stage (D365 → MWG)
            </h3>
            <table className="mt-2 w-full text-xs">
              <tbody className="divide-y divide-border/60 text-foreground/90">
                {[
                  ["In Progress", "prospecting"],
                  ["Won", "closed_won"],
                  ["Lost", "closed_lost"],
                  ["On Hold", "qualification"],
                  ["Cancelled", "closed_lost"],
                ].map(([from, to]) => (
                  <tr key={from}>
                    <td className="py-1 pr-3">{from}</td>
                    <td className="py-1 pr-3 text-muted-foreground/80">→</td>
                    <td className="py-1 font-medium">{to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-lg font-semibold">Allowed values</h2>
        <ul className="mt-3 space-y-1 text-xs text-foreground/90">
          <li>
            <span className="text-muted-foreground">Status: </span>
            {LEAD_STATUSES.join(", ")}
          </li>
          <li>
            <span className="text-muted-foreground">Rating: </span>
            {LEAD_RATINGS.join(", ")}
          </li>
          <li>
            <span className="text-muted-foreground">Source: </span>
            {LEAD_SOURCES.join(", ")}
          </li>
          <li>
            <span className="text-muted-foreground">Opportunity stage: </span>
            prospecting, qualification, proposal, negotiation, closed_won,
            closed_lost
          </li>
        </ul>
      </GlassCard>

      <GlassCard className="mt-6 p-6">
        <h2 className="text-lg font-semibold">
          Re-import idempotency &amp; the &ldquo;By: Name&rdquo; snapshot
        </h2>
        <ul className="mt-3 list-disc pl-6 text-sm text-foreground/80">
          <li>
            <span className="font-medium text-foreground/90">External ID</span> is
            the dedup key for re-imports. Rows whose External ID matches an
            existing non-deleted lead update that lead in place via the
            optimistic-concurrency pipeline; rows without External ID always
            insert new.
          </li>
          <li>
            <span className="font-medium text-foreground/90">
              Activities are deduped
            </span>{" "}
            via a sha256 of (lead_id + kind + occurred_at + first 200
            chars of body). Re-running the same import is idempotent: no
            duplicate activities.
          </li>
          <li>
            <span className="font-medium text-foreground/90">
              &ldquo;By: Name&rdquo; references
            </span>{" "}
            inside activity bodies resolve against{" "}
            <code>users.display_name</code> (then{" "}
            <code>first_name + last_name</code>). Unresolved names are
            stored as <code>activities.imported_by_name</code> so the UI
            can show &ldquo;Tanzania Griffith (imported)&rdquo; until an
            admin remaps to a real user.
          </li>
        </ul>
      </GlassCard>
    </div>
  );
}
