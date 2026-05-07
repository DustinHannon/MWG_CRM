import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema/imports";
import { users } from "@/db/schema/users";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { env } from "@/lib/env";
import { getLeadById } from "@/lib/leads";
import { deleteLeadAction } from "../actions";
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
  const lead = await getLeadById(user, id, perms.canViewAllLeads);
  if (!lead) notFound();

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
      <Link href="/leads" className="text-xs text-white/40 hover:text-white/70">
        ← Back to leads
      </Link>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {lead.firstName} {lead.lastName}
          </h1>
          <p className="mt-1 text-sm text-white/60">
            {lead.jobTitle ? `${lead.jobTitle} · ` : ""}
            {lead.companyName ?? "No company"}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/40">
            <span>
              Created by{" "}
              <span className="text-white/70">
                {creator?.displayName ?? "Deleted user"}
              </span>{" "}
              on {new Date(lead.createdAt).toLocaleDateString()}
            </span>
            {lead.createdVia === "imported" ? (
              <ImportedBadge
                jobId={lead.importJobId}
                filename={importJob?.filename ?? null}
                jobCreatedAt={importJob?.createdAt ?? null}
                isAdmin={user.isAdmin}
              />
            ) : null}
            {lead.createdVia === "api" ? (
              <span className="rounded-full border border-cyan-300/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-cyan-100">
                API
              </span>
            ) : null}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-wide">
            <span className="rounded-full border border-blue-300/30 bg-blue-500/10 px-2 py-0.5 text-blue-100">
              {lead.status}
            </span>
            <span className="rounded-full border border-amber-300/30 bg-amber-500/10 px-2 py-0.5 text-amber-100">
              {lead.rating}
            </span>
            <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-white/60">
              {lead.source.replaceAll("_", " ")}
            </span>
            {lead.doNotContact ? (
              <span className="rounded-full border border-rose-300/30 bg-rose-500/10 px-2 py-0.5 text-rose-100">
                Do not contact
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2">
          {canEdit ? (
            <Link
              href={`/leads/${lead.id}/edit`}
              className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white/80 transition hover:bg-white/10"
            >
              Edit
            </Link>
          ) : null}
          {canDelete ? (
            <form action={deleteLeadAction}>
              <input type="hidden" name="id" value={lead.id} />
              <button
                type="submit"
                className="rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-100 transition hover:bg-rose-500/20"
              >
                Delete
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
          <p className="whitespace-pre-wrap text-sm text-white/80">
            {lead.description ?? <span className="text-white/40">No notes yet.</span>}
          </p>
        </Card>

        {(perms.canSendEmail || user.isAdmin) && !lead.doNotEmail ? (
          <div className="lg:col-span-3">
            <GraphActionPanel
              leadId={lead.id}
              defaultEmail={lead.email}
              defaultName={`${lead.firstName} ${lead.lastName}`.trim()}
              defaultTimeZone={env.DEFAULT_TIMEZONE}
            />
          </div>
        ) : null}

        <div className="lg:col-span-3">
          <ActivityComposer leadId={lead.id} />
        </div>

        <div className="lg:col-span-3">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-white/50">
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
}: {
  jobId: string | null;
  filename: string | null;
  jobCreatedAt: Date | null;
  isAdmin: boolean;
}) {
  const tooltip = filename
    ? `Imported from ${filename}${
        jobCreatedAt
          ? ` on ${new Date(jobCreatedAt).toLocaleDateString()}`
          : ""
      }`
    : "Imported from a spreadsheet";
  const className =
    "rounded-full border border-amber-300/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100";
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
      className={`rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl ${wide ? "lg:col-span-3" : ""}`}
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-white/50">
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
        <p className="text-[11px] uppercase tracking-wide text-white/40">
          {label}
        </p>
        <p className="text-sm text-white/30">—</p>
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
      <p className="text-[11px] uppercase tracking-wide text-white/40">
        {label}
      </p>
      <p className="text-sm text-white/85">{inner}</p>
    </div>
  );
}
