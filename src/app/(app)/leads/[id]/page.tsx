import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema/imports";
import { users } from "@/db/schema/users";
import {
  getCurrentUserTimePrefs,
  UserTime,
} from "@/components/ui/user-time";
import { formatUserTime, type TimePrefs } from "@/lib/format-time";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { getLeadById } from "@/lib/leads";
import { formatPersonName } from "@/lib/format/person-name";
import { deleteLeadAction } from "../actions";
import { ConvertModal } from "./convert/_components/convert-modal";
import { ActivityComposer } from "./activities/activity-composer";
import { ActivityFeed } from "./activities/activity-feed";
import { GraphActionPanel } from "./graph/graph-actions";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  const { id } = await params;
  const lead = await getLeadById(user, id, perms.canViewAllRecords);
  if (!lead) notFound();
  const prefs = await getCurrentUserTimePrefs();

  // Phase 3I — track this view for the Cmd+K palette's recent list.
  void (await import("@/lib/recent-views")).trackView(user.id, "lead", lead.id);

  const canEdit = user.isAdmin || perms.canEditLeads;
  const canDelete = user.isAdmin || perms.canDeleteLeads;

  // Provenance — created-by display name + import job filename. Two
  // small lookups; the joins live here rather than on getLeadById so
  // the table-list path stays a single hot query.
  const [creator, importJob] = await Promise.all([
    lead.createdById
      ? db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, lead.createdById))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    lead.importJobId
      ? db
          .select({
            id: importJobs.id,
            filename: importJobs.filename,
            createdAt: importJobs.createdAt,
          })
          .from(importJobs)
          .where(eq(importJobs.id, lead.importJobId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  return (
    <div className="px-10 py-10">
      <Link href="/leads" className="text-xs text-muted-foreground/80 hover:text-foreground/80">
        ← Back to leads
      </Link>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{formatPersonName(lead)}</h1>
          {lead.subject ? (
            <p className="mt-1 text-sm italic text-muted-foreground">{lead.subject}</p>
          ) : null}
          <p className="mt-1 text-sm text-muted-foreground">
            {lead.jobTitle ? `${lead.jobTitle} · ` : ""}
            {lead.companyName ?? "No company"}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground/80">
            <span>
              Created by{" "}
              <span className="text-foreground/80">
                {creator?.displayName ?? "Deleted user"}
              </span>{" "}
              on <UserTime value={lead.createdAt} mode="date" />
            </span>
            {lead.createdVia === "imported" ? (
              <ImportedBadge
                jobId={lead.importJobId}
                filename={importJob?.filename ?? null}
                jobCreatedAt={importJob?.createdAt ?? null}
                isAdmin={user.isAdmin}
                prefs={prefs}
              />
            ) : null}
            {lead.createdVia === "api" ? (
              <span className="rounded-full border border-cyan-500/30 dark:border-cyan-300/30 bg-cyan-500/20 dark:bg-cyan-500/15 dark:bg-cyan-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-cyan-700 dark:text-cyan-100">
                API
              </span>
            ) : null}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-wide">
            <span className="rounded-full border border-blue-500/30 dark:border-blue-300/30 bg-blue-500/20 dark:bg-blue-500/15 dark:bg-blue-500/10 px-2 py-0.5 text-blue-700 dark:text-blue-100">
              {lead.status}
            </span>
            <span className="rounded-full border border-amber-500/30 dark:border-amber-300/30 bg-amber-500/20 dark:bg-amber-500/15 dark:bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-100">
              {lead.rating}
            </span>
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground">
              {lead.source.replaceAll("_", " ")}
            </span>
            {lead.doNotContact ? (
              <span className="rounded-full border border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 px-2 py-0.5 text-rose-700 dark:text-rose-100">
                Do not contact
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2">
          {canEdit && lead.status !== "converted" ? (
            <ConvertModal
              leadId={lead.id}
              leadDisplayName={formatPersonName(lead)}
              defaultCompany={lead.companyName}
              defaultFirstName={lead.firstName}
              defaultLastName={lead.lastName}
              defaultJobTitle={lead.jobTitle}
              defaultEmail={lead.email}
              defaultPhone={lead.phone}
              defaultMobile={lead.mobilePhone}
              defaultEstValue={lead.estimatedValue}
            />
          ) : null}
          {canEdit ? (
            <Link
              href={`/leads/${lead.id}/edit`}
              className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
            >
              Edit
            </Link>
          ) : null}
          <a
            href={`/leads/print/${lead.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
            title="Open print preview — use your browser's Save as PDF"
          >
            Print / PDF
          </a>
          {canDelete ? (
            <form
              action={async (fd) => {
                "use server";
                await deleteLeadAction(fd);
              }}
            >
              <input type="hidden" name="id" value={lead.id} />
              <button
                type="submit"
                className="rounded-md border border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 px-3 py-1.5 text-sm text-rose-700 dark:text-rose-100 transition hover:bg-destructive/20"
              >
                Archive
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <Card title="Contact">
          <Field label="Email" value={lead.email} mailto />
          <Field label="Phone" value={lead.phone} tel />
          <Field label="Mobile" value={lead.mobilePhone} tel />
          <Field label="Website" value={lead.website} link />
          <Field label="LinkedIn" value={lead.linkedinUrl} link />
        </Card>

        <Card title="Address">
          <Field label="Street 1" value={lead.street1} />
          <Field label="Street 2" value={lead.street2} />
          <Field label="City" value={lead.city} />
          <Field label="State" value={lead.state} />
          <Field label="Postal code" value={lead.postalCode} />
          <Field label="Country" value={lead.country} />
        </Card>

        <Card title="Pipeline">
          <Field label="Industry" value={lead.industry} />
          <Field
            label="Estimated value"
            value={lead.estimatedValue ? `$${lead.estimatedValue}` : null}
          />
          <Field
            label="Estimated close"
            value={lead.estimatedCloseDate ?? null}
          />
          <Field
            label="Tags"
            value={lead.tags && lead.tags.length > 0 ? lead.tags.join(", ") : null}
          />
        </Card>

        <Card title="Description" wide>
          <p className="whitespace-pre-wrap text-sm text-foreground/90">
            {lead.description ?? <span className="text-muted-foreground/80">No notes yet.</span>}
          </p>
        </Card>

        {(perms.canSendEmail || user.isAdmin) && !lead.doNotEmail ? (
          <div className="lg:col-span-3">
            <GraphActionPanel
              leadId={lead.id}
              defaultEmail={lead.email}
              defaultName={formatPersonName(lead)}
              defaultTimeZone={env.DEFAULT_TIMEZONE}
            />
          </div>
        ) : null}

        <div className="lg:col-span-3">
          <ActivityComposer leadId={lead.id} />
        </div>

        <div className="lg:col-span-3">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Activity timeline
          </h2>
          <ActivityFeed leadId={lead.id} user={user} />
        </div>
      </div>
    </div>
  );
}

/**
 * Imported badge — surfaces the import job's filename + date in the
 * native browser tooltip via title=. Admin sees a link into a future
 * /admin/imports/<id> page (placeholder for now); non-admins just
 * get the tooltip.
 */
function ImportedBadge({
  jobId,
  filename,
  jobCreatedAt,
  isAdmin,
  prefs,
}: {
  jobId: string | null;
  filename: string | null;
  jobCreatedAt: Date | null;
  isAdmin: boolean;
  prefs: TimePrefs;
}) {
  const tooltip = filename
    ? `Imported from ${filename}${
        jobCreatedAt
          ? ` on ${formatUserTime(jobCreatedAt, prefs, "date")}`
          : ""
      }`
    : "Imported from a spreadsheet";
  const className =
    "rounded-full border border-amber-500/30 dark:border-amber-300/30 bg-amber-500/20 dark:bg-amber-500/15 dark:bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-100";
  if (isAdmin && jobId) {
    return (
      <Link
        href={`/admin/audit?action=leads.import&target=${jobId}`}
        title={tooltip}
        className={`${className} hover:bg-amber-500/20`}
      >
        Imported
      </Link>
    );
  }
  return (
    <span title={tooltip} className={className}>
      Imported
    </span>
  );
}

function Card({
  title,
  children,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl ${wide ? "lg:col-span-3" : ""}`}
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  mailto,
  tel,
  link,
}: {
  label: string;
  value: string | null | undefined;
  mailto?: boolean;
  tel?: boolean;
  link?: boolean;
}) {
  if (!value) {
    return (
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
          {label}
        </p>
        <p className="text-sm text-muted-foreground/70">—</p>
      </div>
    );
  }

  let inner: React.ReactNode = value;
  if (mailto) inner = <a href={`mailto:${value}`} className="hover:underline">{value}</a>;
  if (tel) inner = <a href={`tel:${value}`} className="hover:underline">{value}</a>;
  if (link)
    inner = (
      <a href={value} target="_blank" rel="noreferrer" className="hover:underline">
        {value}
      </a>
    );

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </p>
      <p className="text-sm text-foreground/90">{inner}</p>
    </div>
  );
}
