import "server-only";

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { importRuns } from "@/db/schema/d365-imports";
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
 * Phase 23 — companion to `halt-detection.ts` and the H-1 halt path
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
 *                          Resolution discriminated union                     *
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
 *                              Validation matrix                              *
 * -------------------------------------------------------------------------- */

const ALLOWED_RESOLUTIONS: Record<D365HaltReason, ResumeResolution["kind"][]> =
  {
    [D365_HALT_REASONS.D365_UNREACHABLE]: ["retry"],
    [D365_HALT_REASONS.UNMAPPED_PICKLIST]: ["fix_picklist", "open_for_review"],
    [D365_HALT_REASONS.HIGH_VOLUME_CONFLICT]: [
      "apply_dedup_default",
      "open_for_review",
    ],
    [D365_HALT_REASONS.OWNER_JIT_FAILURE]: [
      "use_default_owner",
      "open_for_review",
    ],
    [D365_HALT_REASONS.VALIDATION_REGRESSION]: ["open_for_review"],
  };

/**
 * Map resolution kind -> the run.status to land in.
 *
 *   retry / use_default_owner       → `fetching`     (worker re-pulls)
 *   fix_picklist                    → `mapping`      (re-map then review)
 *   apply_dedup_default             → `mapping`      (re-evaluate dedup)
 *   open_for_review                 → `reviewing`    (human walks rows)
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

/* -------------------------------------------------------------------------- *
 *                                 resumeRun                                   *
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
    const valid = new Set(["skip", "overwrite", "merge"]);
    if (!valid.has(resolution.defaultBehavior)) {
      throw new ValidationError(
        `Invalid defaultBehavior '${resolution.defaultBehavior}'.`,
        { allowed: [...valid] },
      );
    }
  }

  const nextStatus = NEXT_STATUS[resolution.kind];
  const noteEntry = {
    type: "resume",
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
 *                       Notes parsing — last halt entry                      *
 * -------------------------------------------------------------------------- */

const HALT_REASON_VALUES = new Set<string>(Object.values(D365_HALT_REASONS));

interface HaltNoteEntry {
  reason?: string;
  type?: string;
}

/**
 * `import_runs.notes` is an append-only stream of JSON-encoded lines.
 * We walk it bottom-up to find the most recent `RUN_HALTED` entry and
 * return its `reason` (one of `D365_HALT_REASONS`).
 *
 * Tolerant of:
 *   - trailing/leading whitespace
 *   - non-JSON lines (skipped; logged WARN once at parse time)
 *   - missing/legacy `type` keys (we still trust an entry whose
 *     `reason` value is in the halt-reason whitelist)
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
    // A "resume" entry SUPERSEDES the prior halt — once a run was
    // resumed, the next pause must record a fresh halt entry. So if
    // we see a resume before a halt walking bottom-up, there's no
    // active halt to resolve.
    if (parsed.type === "resume") return null;
    if (
      typeof parsed.reason === "string" &&
      HALT_REASON_VALUES.has(parsed.reason)
    ) {
      return parsed.reason as D365HaltReason;
    }
  }
  return null;
}
