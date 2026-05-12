import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  importBatches,
  importRecords,
  importRuns,
} from "@/db/schema/d365-imports";
import { BreadcrumbsSetter } from "@/components/breadcrumbs";
import { GlassCard } from "@/components/ui/glass-card";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  BatchReviewPane,
  type BatchChildView,
  type BatchRecordView,
  type ConflictResolution,
  type RecordStatus,
  type ValidationWarning,
} from "@/components/admin/d365-import/batch-review-pane";
import { BatchStatusPill, RunStatusPill } from "../../_components/run-status-pill";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ runId: string; batchId: string }>;
}

export default async function BatchReviewPage({ params }: PageProps) {
  await requireAdmin();
  const { runId, batchId } = await params;

  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (!uuidRe.test(runId) || !uuidRe.test(batchId)) {
    notFound();
  }

  const [batch] = await db
    .select({
      id: importBatches.id,
      runId: importBatches.runId,
      batchNumber: importBatches.batchNumber,
      status: importBatches.status,
      recordCountFetched: importBatches.recordCountFetched,
      recordCountApproved: importBatches.recordCountApproved,
      recordCountRejected: importBatches.recordCountRejected,
      recordCountCommitted: importBatches.recordCountCommitted,
    })
    .from(importBatches)
    .where(eq(importBatches.id, batchId))
    .limit(1);
  if (!batch || batch.runId !== runId) notFound();

  const [run] = await db
    .select({
      id: importRuns.id,
      entityType: importRuns.entityType,
      status: importRuns.status,
      createdAt: importRuns.createdAt,
    })
    .from(importRuns)
    .where(eq(importRuns.id, runId))
    .limit(1);
  if (!run) notFound();

  const recordRows = await db
    .select({
      id: importRecords.id,
      sourceEntityType: importRecords.sourceEntityType,
      sourceId: importRecords.sourceId,
      status: importRecords.status,
      rawPayload: importRecords.rawPayload,
      mappedPayload: importRecords.mappedPayload,
      validationWarnings: importRecords.validationWarnings,
      conflictResolution: importRecords.conflictResolution,
      conflictWith: importRecords.conflictWith,
      error: importRecords.error,
    })
    .from(importRecords)
    .where(eq(importRecords.batchId, batchId))
    .orderBy(asc(importRecords.id));

  // mapped_payload from map-batch.ts is a wrapper:
  //   { mapped, attached, customFields }
  // The actual insertable lives at `.mapped`; `attached` is an array of
  // children pre-built by the mapper; `customFields` is the D365 custom
  // field passthrough kept around for transparency in the UI.
  const records: BatchRecordView[] = recordRows.map((r) => {
    const raw = (r.rawPayload ?? {}) as Record<string, unknown>;
    const wrapper = (r.mappedPayload ?? null) as
      | (Record<string, unknown> & {
          mapped?: Record<string, unknown>;
          attached?: Array<Record<string, unknown>>;
          customFields?: Record<string, unknown>;
        })
      | null;

    const mapped: Record<string, unknown> | null =
      wrapper && typeof wrapper === "object"
        ? wrapper.mapped && typeof wrapper.mapped === "object"
          ? wrapper.mapped
          : // Defensive: if the wrapper shape was bypassed and the
            // insertable was written flat, treat it as the mapped object.
            wrapper
        : null;

    const attached: Array<Record<string, unknown>> = Array.isArray(
      wrapper?.attached,
    )
      ? (wrapper!.attached as Array<Record<string, unknown>>)
      : [];
    const customFields: Record<string, unknown> =
      wrapper?.customFields && typeof wrapper.customFields === "object"
        ? (wrapper.customFields as Record<string, unknown>)
        : {};

    const warnings = Array.isArray(r.validationWarnings)
      ? (r.validationWarnings as ValidationWarning[])
      : [];

    const summary = buildSummary(r.sourceEntityType, raw, mapped);
    const meta = (mapped?._meta ?? null) as
      | { ownerResolutionSource?: string }
      | null;

    const children: BatchChildView[] = attached.map((a, idx) => ({
      id: `${r.id}-attached-${idx}`,
      sourceEntityType: typeof a.kind === "string" ? `activity (${a.kind})` : "activity",
      sourceId: typeof a.externalId === "string" ? (a.externalId as string) : "",
      summary:
        typeof a.subject === "string" && a.subject.length > 0
          ? (a.subject as string)
          : typeof a.body === "string"
            ? (a.body as string).slice(0, 80)
            : "(no summary)",
      status: "mapped",
    }));

    return {
      id: r.id,
      sourceEntityType: r.sourceEntityType,
      sourceId: r.sourceId,
      status: r.status as RecordStatus,
      rawPayload: raw,
      mappedPayload: mapped,
      customFields,
      validationWarnings: warnings,
      conflictResolution:
        (r.conflictResolution as ConflictResolution | null) ?? null,
      conflictWith: r.conflictWith,
      resolvedFromDefaultOwner:
        meta?.ownerResolutionSource === "default_owner",
      summary,
      children,
      error: r.error,
    };
  });

  const readOnly =
    batch.status === "committed" ||
    run.status === "completed" ||
    run.status === "aborted";

  return (
    <div className="px-4 py-6 sm:px-6 sm:py-8 xl:px-10 xl:py-10">
      <BreadcrumbsSetter
        crumbs={[
          { label: "Admin", href: "/admin" },
          { label: "Imports" },
          { label: "D365", href: "/admin/d365-import" },
          {
            label: `Run ${run.entityType}`,
            href: `/admin/d365-import/${runId}`,
          },
          { label: `Batch #${batch.batchNumber}` },
        ]}
      />

      <header className="space-y-2">
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          <Link
            href={`/admin/d365-import/${runId}`}
            className="underline-offset-2 hover:underline"
          >
            ← Back to run
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-foreground font-display">
            Batch #{batch.batchNumber}
          </h1>
          <BatchStatusPill status={batch.status} />
          <RunStatusPill status={run.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {batch.recordCountFetched} fetched · {batch.recordCountApproved}{" "}
          approved · {batch.recordCountRejected} rejected ·{" "}
          {batch.recordCountCommitted} committed
        </p>
      </header>

      <div className="mt-6">
        <GlassCard className="p-4">
          <BatchReviewPane
            runId={runId}
            batchId={batchId}
            records={records}
            readOnly={readOnly}
          />
        </GlassCard>
      </div>
    </div>
  );
}

/**
 * Build a 1-3 line summary string for the left-hand record list.
 * Pulls from the most useful D365 fields per entity type, with
 * mapped-payload preferred over raw when present.
 */
function buildSummary(
  entityType: string,
  raw: Record<string, unknown>,
  mapped: Record<string, unknown> | null,
): { primary: string; secondary?: string | null; tertiary?: string | null } {
  const m = mapped ?? {};
  switch (entityType) {
    case "lead":
    case "contact": {
      const first = pickStr(m, ["firstName", "first_name"]) ?? pickStr(raw, ["firstname"]);
      const last = pickStr(m, ["lastName", "last_name"]) ?? pickStr(raw, ["lastname"]);
      const full = [first, last].filter(Boolean).join(" ").trim();
      const company = pickStr(m, ["companyName"]) ?? pickStr(raw, ["companyname"]);
      const email = pickStr(m, ["email"]) ?? pickStr(raw, ["emailaddress1"]);
      return {
        primary: full || pickStr(raw, ["fullname"]) || "(unnamed)",
        secondary: company ?? email,
        tertiary: company && email ? email : pickStr(m, ["city"]) ?? pickStr(raw, ["address1_city"]),
      };
    }
    case "account": {
      return {
        primary: pickStr(m, ["name"]) ?? pickStr(raw, ["name"]) ?? "(unnamed)",
        secondary: pickStr(m, ["industry"]) ?? pickStr(raw, ["industrycode"])?.toString() ?? null,
        tertiary: pickStr(m, ["website"]) ?? pickStr(raw, ["websiteurl"]),
      };
    }
    case "opportunity": {
      return {
        primary: pickStr(m, ["name"]) ?? pickStr(raw, ["name"]) ?? "(untitled)",
        secondary: pickStr(raw, ["estimatedvalue"])?.toString() ?? null,
        tertiary: pickStr(raw, ["estimatedclosedate"]),
      };
    }
    case "annotation": {
      return {
        primary: pickStr(raw, ["subject"]) ?? "(no subject)",
        secondary:
          pickStr(raw, ["notetext"])?.slice(0, 80) ?? null,
        tertiary: pickStr(raw, ["objecttypecode"]),
      };
    }
    case "task":
    case "phonecall":
    case "appointment":
    case "email": {
      return {
        primary: pickStr(raw, ["subject"]) ?? `(${entityType})`,
        secondary: pickStr(raw, ["scheduledstart"]) ?? null,
        tertiary: pickStr(raw, ["description"])?.slice(0, 80) ?? null,
      };
    }
    default:
      return {
        primary: pickStr(raw, ["name"]) ?? "(no summary)",
      };
  }
}

function pickStr(
  o: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
