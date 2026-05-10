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

  // Build the BatchRecordView shapes the client component expects.
  // Detect "default-owner" resolution by inspecting mappedPayload.
  // Sub-agent B's mapper writes `{ ownerResolutionSource: "default_owner" }`
  // into `mappedPayload._meta`; we read it defensively here.
  const records: BatchRecordView[] = recordRows.map((r) => {
    const raw = (r.rawPayload ?? {}) as Record<string, unknown>;
    const mapped = (r.mappedPayload ?? null) as
      | (Record<string, unknown> & {
          _meta?: { ownerResolutionSource?: string };
        })
      | null;
    const warnings = Array.isArray(r.validationWarnings)
      ? (r.validationWarnings as ValidationWarning[])
      : [];
    const summary = buildSummary(r.sourceEntityType, raw, mapped);
    return {
      id: r.id,
      sourceEntityType: r.sourceEntityType,
      sourceId: r.sourceId,
      status: r.status as RecordStatus,
      rawPayload: raw,
      mappedPayload: mapped,
      validationWarnings: warnings,
      conflictResolution:
        (r.conflictResolution as ConflictResolution | null) ?? null,
      conflictWith: r.conflictWith,
      resolvedFromDefaultOwner:
        mapped?._meta?.ownerResolutionSource === "default_owner",
      summary,
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
        secondary: company,
        tertiary: email,
      };
    }
    case "account": {
      return {
        primary: pickStr(m, ["name"]) ?? pickStr(raw, ["name"]) ?? "(unnamed)",
        secondary: pickStr(raw, ["industrycode"])?.toString() ?? null,
        tertiary: pickStr(raw, ["websiteurl"]),
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
