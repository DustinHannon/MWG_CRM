import "server-only";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  importBatches,
  importRecords,
  importRuns,
} from "@/db/schema/d365-imports";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  D365_AUDIT_EVENTS,
  D365_HALT_REASONS,
  type D365HaltReason,
} from "./audit-events";
import { broadcastRunEvent } from "./realtime-broadcast";

/**
 * companion to `halt-detection.ts` and the H-1 halt path
 * in `pull-batch.ts`.
 *
 * `resumeRun` validates a reviewer's resolution against the halt
 * reason persisted in the run's notes, records the resolution as a
 * new appended note line, transitions status back to the appropriate
 * working state, and emits audit + realtime.
 *
 * NOTE: this function does NOT re-kick the worker. The caller (a
 * server action behind a "Resume" button) is responsible for the
 * follow-up `pullNextBatch` / mapping / commit call so the user-
 * facing state can reflect the new work being initiated.
 */

/* -------------------------------------------------------------------------- *
 * Resolution discriminated union *
 * -------------------------------------------------------------------------- */

export type ResumeResolution =
  /** H-1: D365 came back online — try the same batch again. */
  | { kind: "retry" }
  /** H-2: reviewer/admin updated the picklist registry; try again. */
  | { kind: "fix_picklist" }
  /**
   * H-3: dedup conflict spike — apply the chosen default conflict
   * behavior to the remaining records and proceed.
   */
  | {
      kind: "apply_dedup_default";
      defaultBehavior: "skip" | "overwrite" | "merge";
    }
  /** H-4: owner JIT failed — fall back to the configured default owner. */
  | { kind: "use_default_owner" }
  /**
   * H-5: validation regression — keep the batch in review state so a
   * human walks every record before commit.
   */
  | { kind: "open_for_review" };

/* -------------------------------------------------------------------------- *
 * Validation matrix *
 * -------------------------------------------------------------------------- */

const ALLOWED_RESOLUTIONS: Record<D365HaltReason, ResumeResolution["kind"][]> =
  {
    [D365_HALT_REASONS.D365_UNREACHABLE]: ["retry"],
    [D365_HALT_REASONS.UNMAPPED_PICKLIST]: ["fix_picklist", "open_for_review"],
    [D365_HALT_REASONS.HIGH_VOLUME_CONFLICT]: [
      "apply_dedup_default",
      "open_for_review",
    ],
    // bad-lead-volume halt only resolves via human
    // review of the batch (admin walks the auto-skipped records,
    // confirms or un-skips). No bulk resolution makes sense here
    // because each record's "bad" reason can be different.
    [D365_HALT_REASONS.BAD_LEAD_VOLUME]: ["open_for_review"],
    [D365_HALT_REASONS.OWNER_JIT_FAILURE]: [
      "use_default_owner",
      "open_for_review",
    ],
    [D365_HALT_REASONS.VALIDATION_REGRESSION]: ["open_for_review"],
    // Child-collection truncation is a fetch-time halt (the per-batch
    // hard cap fired before a collection drained). The only resolution
    // is to re-pull the page once the operator has narrowed the scope or
    // raised the cap — so `retry`, which lands the run back in
    // `fetching` for a fresh pull (same as D365_UNREACHABLE).
    [D365_HALT_REASONS.CHILD_COLLECTION_TRUNCATED]: ["retry"],
  };

/**
 * Map resolution kind -> the run.status to land in.
 *
 * retry / use_default_owner → `fetching` (worker re-pulls)
 * fix_picklist → `mapping` (re-map then review)
 * apply_dedup_default → `mapping` (re-evaluate dedup)
 * open_for_review → `reviewing` (human walks rows)
 */
const NEXT_STATUS: Record<
  ResumeResolution["kind"],
  typeof importRuns.$inferSelect.status
> = {
  retry: "fetching",
  use_default_owner: "fetching",
  fix_picklist: "mapping",
  apply_dedup_default: "mapping",
  open_for_review: "reviewing",
};

/**
 * Translate the reviewer's chosen default conflict behavior (the
 * `apply_dedup_default` payload) into the durable
 * `import_records.conflict_resolution` enum that `commit-batch`
 * consumes. Without this translation the choice is inert: dedup runs
 * default to `dedup_merge`, and `commitParentEntity` only honors
 * `dedup_skip` / `dedup_overwrite` when the record's stored resolution
 * says so. Re-mapping does NOT re-derive these records (the conflicted
 * rows are no longer `pending`), so the resolution must be written here.
 */
const DEDUP_DEFAULT_TO_RESOLUTION = {
  skip: "dedup_skip",
  overwrite: "dedup_overwrite",
  merge: "dedup_merge",
} as const satisfies Record<
  Extract<ResumeResolution, { kind: "apply_dedup_default" }>["defaultBehavior"],
  NonNullable<typeof importRecords.$inferSelect.conflictResolution>
>;

/* -------------------------------------------------------------------------- *
 * resumeRun *
 * -------------------------------------------------------------------------- */

export async function resumeRun(
  runId: string,
  resolution: ResumeResolution,
  actorId: string,
): Promise<void> {
  if (!runId) throw new ValidationError("runId is required.");
  if (!actorId) throw new ValidationError("actorId is required.");
  if (!resolution || typeof resolution !== "object") {
    throw new ValidationError("resolution is required.");
  }

  const [run] = await db
    .select({
      id: importRuns.id,
      status: importRuns.status,
      notes: importRuns.notes,
    })
    .from(importRuns)
    .where(eq(importRuns.id, runId))
    .limit(1);
  if (!run) throw new NotFoundError("import run");

  if (run.status !== "paused_for_review") {
    throw new ConflictError(
      `Run is in status '${run.status}'; only paused runs can be resumed.`,
      { status: run.status },
    );
  }

  const haltReason = parseLastHaltReason(run.notes);
  if (!haltReason) {
    throw new ConflictError(
      "Run has no recorded halt reason; cannot resume.",
      { runId },
    );
  }

  const allowed = ALLOWED_RESOLUTIONS[haltReason] ?? [];
  if (!allowed.includes(resolution.kind)) {
    throw new ValidationError(
      `Resolution '${resolution.kind}' is not valid for halt reason '${haltReason}'. Allowed: ${allowed.join(", ")}`,
      { haltReason, allowed, attempted: resolution.kind },
    );
  }

  // Extra payload validation for the dedup choice.
  if (resolution.kind === "apply_dedup_default") {
    if (!(resolution.defaultBehavior in DEDUP_DEFAULT_TO_RESOLUTION)) {
      throw new ValidationError(
        `Invalid defaultBehavior '${resolution.defaultBehavior}'.`,
        { allowed: Object.keys(DEDUP_DEFAULT_TO_RESOLUTION) },
      );
    }

    // Apply the chosen default to every still-actionable conflicting
    // record in this run so `commit-batch` honors it. dispatchDedup
    // always returns `dedup_merge` for a match, so without this write
    // 'skip all' / 'overwrite all' would silently force-merge. Scope to
    // records that (a) actually conflict (`conflict_with` set) and (b)
    // have not yet been finalized — committed / skipped / rejected /
    // failed records keep their resolved state; a reviewer's explicit
    // per-record override (already approved) is also preserved.
    const resolutionValue =
      DEDUP_DEFAULT_TO_RESOLUTION[resolution.defaultBehavior];
    const updated = await db
      .update(importRecords)
      .set({ conflictResolution: resolutionValue })
      .where(
        and(
          isNotNull(importRecords.conflictWith),
          inArray(importRecords.status, ["pending", "mapped", "review"]),
          inArray(
            importRecords.batchId,
            db
              .select({ id: importBatches.id })
              .from(importBatches)
              .where(eq(importBatches.runId, runId)),
          ),
        ),
      )
      .returning({ id: importRecords.id });

    logger.info("d365.run.dedup_default_applied", {
      runId,
      defaultBehavior: resolution.defaultBehavior,
      conflictResolution: resolutionValue,
      recordsUpdated: updated.length,
    });
  }

  const nextStatus = NEXT_STATUS[resolution.kind];
  // Note shape MUST use `kind` not `type` — the run-detail page's
  // parseHaltFromNotes (and the polling endpoint's extractHaltReason)
  // walk the JSON-line stream looking for `kind === "halt"` /
  // `kind === "resume"` to detect supersedes. Mismatched key names
  // cause stale halt banners to linger after a real resume.
  const noteEntry = {
    kind: "resume" as const,
    haltReason,
    resolution,
    actorId,
    ts: new Date().toISOString(),
  };
  const noteLine = `${JSON.stringify(noteEntry)}\n`;

  await db
    .update(importRuns)
    .set({
      status: nextStatus,
      notes: sql`coalesce(${importRuns.notes}, '') || ${noteLine}`,
    })
    .where(eq(importRuns.id, runId));

  await writeAudit({
    actorId,
    action: D365_AUDIT_EVENTS.RUN_RESUMED,
    targetType: "import_run",
    targetId: runId,
    after: {
      haltReason,
      resolution,
      nextStatus,
    },
  });

  await broadcastRunEvent(runId, "resumed", {
    haltReason,
    resolution,
    nextStatus,
  });

  logger.info("d365.run.resumed", {
    runId,
    haltReason,
    resolutionKind: resolution.kind,
    nextStatus,
  });
}

/* -------------------------------------------------------------------------- *
 * Notes parsing — last halt entry *
 * -------------------------------------------------------------------------- */

const HALT_REASON_VALUES = new Set<string>(Object.values(D365_HALT_REASONS));

interface HaltNoteEntry {
  reason?: string;
  /**
   * F-Ω-2: the resume / halt note shape uses `kind` (see resumeRun
   * above + pull-batch.ts halt-note writer + map-batch.ts halt-note
   * writer + the run-detail page's parseHaltFromNotes + the polling
   * endpoint's extractHaltReason). The legacy `type` key never lands
   * in production data; kept here as a tolerated alias only because
   * removing the field would imply a schema change to existing
   * import_runs.notes rows. Both keys are checked below.
   */
  kind?: string;
  type?: string;
}

/**
 * `import_runs.notes` is an append-only stream of JSON-encoded lines.
 * We walk it bottom-up to find the most recent `RUN_HALTED` entry and
 * return its `reason` (one of `D365_HALT_REASONS`).
 *
 * Tolerant of:
 * trailing/leading whitespace
 * non-JSON lines (skipped; logged WARN once at parse time)
 * missing/legacy `kind` keys (we still trust an entry whose
 * `reason` value is in the halt-reason whitelist)
 */
export function parseLastHaltReason(
  notes: string | null,
): D365HaltReason | null {
  if (!notes) return null;
  const lines = notes.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i].trim();
    if (!raw || raw[0] !== "{") continue;
    let parsed: HaltNoteEntry | null = null;
    try {
      parsed = JSON.parse(raw) as HaltNoteEntry;
    } catch {
      continue;
    }
    if (!parsed) continue;
    // F-Ω-2: a "resume" entry SUPERSEDES the prior halt — once a run
    // was resumed, the next pause must record a fresh halt entry. So
    // if we see a resume before a halt walking bottom-up, there's no
    // active halt to resolve. The canonical note shape uses `kind`
    // (see comment on HaltNoteEntry above); the legacy `type` is
    // tolerated as an alias so any pre-canonicalization rows still
    // parse.
    if (parsed.kind === "resume" || parsed.type === "resume") return null;
    if (
      typeof parsed.reason === "string" &&
      HALT_REASON_VALUES.has(parsed.reason)
    ) {
      return parsed.reason as D365HaltReason;
    }
  }
  return null;
}
