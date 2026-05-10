"use client";

import { useState, useTransition } from "react";
import { TriangleAlert } from "lucide-react";
import { resumeRunAction, abortRunAction } from "@/app/admin/d365-import/actions";
import { cn } from "@/lib/utils";

/**
 * Phase 23 — Halt-banner for paused_for_review runs.
 *
 * Five reason variants per Phase 23 §4.5:
 *   - d365_unreachable        → Retry / Abort
 *   - unmapped_picklist       → Resume after fix / Abort
 *   - high_volume_conflict    → skip|overwrite|merge radio + Apply / Abort
 *   - owner_jit_failure       → Use default owner and resume / Abort
 *   - validation_regression   → Open batch for review (link) / Abort
 *
 * Reads the halt reason as a JSON-decoded last line of
 * `import_runs.notes` (server-side parsing happens on the run-detail
 * page; this component receives the parsed object via props).
 */

export type HaltReason =
  | "d365_unreachable"
  | "unmapped_picklist"
  | "high_volume_conflict"
  | "owner_jit_failure"
  | "validation_regression"
  | "bad_lead_volume";

export interface HaltBannerProps {
  runId: string;
  reason: HaltReason;
  message?: string | null;
  /** For validation_regression / bad_lead_volume: the batch that needs review. */
  pendingBatchId?: string | null;
  /** For high_volume_conflict: how many records collided. */
  conflictCount?: number;
  /** For owner_jit_failure: how many records fell back. */
  defaultOwnerCount?: number;
  /** For bad_lead_volume: how many records auto-skipped as garbage. */
  garbageCount?: number;
}

const REASON_TITLE: Record<HaltReason, string> = {
  d365_unreachable: "Dynamics 365 is unreachable",
  unmapped_picklist: "Unmapped picklist value",
  high_volume_conflict: "High-volume duplicate conflict",
  owner_jit_failure: "Owner could not be resolved",
  validation_regression: "Validation regression detected",
  bad_lead_volume: "High volume of bad-quality records",
};

export function HaltBanner(props: HaltBannerProps) {
  return (
    <div className="rounded-lg border border-[var(--status-lost-bg)] bg-[var(--status-lost-bg)]/30 p-4">
      <div className="flex items-start gap-3">
        <TriangleAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-[var(--status-lost-fg)]"
          strokeWidth={1.5}
        />
        <div className="grow">
          <h3 className="text-sm font-semibold text-foreground">
            {REASON_TITLE[props.reason]}
          </h3>
          {props.message ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {props.message}
            </p>
          ) : null}

          <ReasonBody {...props} />
        </div>
      </div>
    </div>
  );
}

function ReasonBody(props: HaltBannerProps) {
  switch (props.reason) {
    case "d365_unreachable":
      return (
        <ResumeOrAbort
          runId={props.runId}
          reason={props.reason}
          resumeLabel="Retry"
          help="The pipeline retried 3 times before halting. Click Retry to attempt the next page again."
        />
      );
    case "unmapped_picklist":
      return (
        <ResumeOrAbort
          runId={props.runId}
          reason={props.reason}
          resumeLabel="Resume after fix"
          help="Update the mapping registry, then click Resume to continue from the same batch."
        />
      );
    case "owner_jit_failure":
      return (
        <ResumeOrAbort
          runId={props.runId}
          reason={props.reason}
          resumeLabel="Use default owner and resume"
          help={
            props.defaultOwnerCount
              ? `${props.defaultOwnerCount} records fell back to the default owner. Resuming applies the fallback.`
              : "Resuming will assign affected records to the configured default owner."
          }
        />
      );
    case "high_volume_conflict":
      return (
        <ConflictResolutionForm
          runId={props.runId}
          conflictCount={props.conflictCount}
        />
      );
    case "validation_regression":
      return (
        <ValidationRegressionActions
          runId={props.runId}
          pendingBatchId={props.pendingBatchId}
        />
      );
    case "bad_lead_volume":
      return (
        <ValidationRegressionActions
          runId={props.runId}
          pendingBatchId={props.pendingBatchId}
        />
      );
    default:
      return null;
  }
}

function ResumeOrAbort({
  runId,
  reason,
  resumeLabel,
  help,
}: {
  runId: string;
  reason: HaltReason;
  resumeLabel: string;
  help?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onResume() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("runId", runId);
      fd.set("reason", reason);
      const res = await resumeRunAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <div className="mt-3 space-y-2">
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onResume}
          disabled={pending}
          className={cn(
            "rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50",
          )}
        >
          {pending ? "Resuming…" : resumeLabel}
        </button>
        <AbortButton runId={runId} disabled={pending} />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function ConflictResolutionForm({
  runId,
  conflictCount,
}: {
  runId: string;
  conflictCount?: number;
}) {
  const [resolution, setResolution] = useState<
    "dedup_skip" | "dedup_overwrite" | "dedup_merge"
  >("dedup_merge");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onApply() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("runId", runId);
      fd.set("reason", "high_volume_conflict");
      fd.set("conflictResolution", resolution);
      const res = await resumeRunAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  const options: Array<{
    value: typeof resolution;
    label: string;
    desc: string;
  }> = [
    {
      value: "dedup_skip",
      label: "Skip",
      desc: "Don't import duplicates; keep existing local rows untouched.",
    },
    {
      value: "dedup_overwrite",
      label: "Overwrite",
      desc: "Replace local rows with D365 values where they differ.",
    },
    {
      value: "dedup_merge",
      label: "Merge (default)",
      desc: "Fill in only the local fields that are NULL or empty.",
    },
  ];

  return (
    <div className="mt-3 space-y-3">
      {conflictCount ? (
        <p className="text-xs text-muted-foreground">
          {conflictCount} records in this batch already exist locally.
          Choose a resolution to apply to all and resume.
        </p>
      ) : null}
      <fieldset className="space-y-1.5">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded border border-border bg-background/40 px-2 py-1.5",
              resolution === opt.value && "border-foreground/40",
            )}
          >
            <input
              type="radio"
              name="resolution"
              value={opt.value}
              checked={resolution === opt.value}
              onChange={() => setResolution(opt.value)}
              className="mt-0.5"
            />
            <div className="text-xs">
              <div className="font-medium text-foreground">{opt.label}</div>
              <div className="text-muted-foreground">{opt.desc}</div>
            </div>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={pending}
          className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Applying…" : "Apply and resume"}
        </button>
        <AbortButton runId={runId} disabled={pending} />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function ValidationRegressionActions({
  runId,
  pendingBatchId,
}: {
  runId: string;
  pendingBatchId?: string | null;
}) {
  const [pending] = useTransition();
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        Mapper validation rejected more records than the threshold allows.
        Open the batch to review individual records before resuming.
      </p>
      <div className="flex flex-wrap gap-2">
        {pendingBatchId ? (
          <a
            href={`/admin/d365-import/${runId}/${pendingBatchId}`}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
          >
            Open batch for review
          </a>
        ) : null}
        <AbortButton runId={runId} disabled={pending} />
      </div>
    </div>
  );
}

function AbortButton({
  runId,
  disabled,
}: {
  runId: string;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onAbort() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Abort this import run? Records already committed will remain; nothing else will be imported.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("runId", runId);
      const res = await abortRunAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onAbort}
        disabled={disabled || pending}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
      >
        {pending ? "Aborting…" : "Abort run"}
      </button>
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : null}
    </>
  );
}
