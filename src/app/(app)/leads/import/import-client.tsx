"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  cancelImportAction,
  commitImportAction,
  previewImportAction,
  type CommitSuccessData,
  type PreviewSuccessData,
} from "./actions";
import type { ActionResult } from "@/lib/server-action";

type Stage = "upload" | "preview" | "result";

export function ImportClient() {
  const [stage, setStage] = useState<Stage>("upload");
  const [previewState, setPreviewState] = useState<PreviewSuccessData | null>(
    null,
  );
  const [commitState, setCommitState] = useState<
    ActionResult<CommitSuccessData> | null
  >(null);
  const [pending, startTransition] = useTransition();
  const [uploadError, setUploadError] = useState<string | null>(null);

  function onUpload(formData: FormData) {
    setUploadError(null);
    startTransition(async () => {
      const res = await previewImportAction(formData);
      if (!res.ok) {
        setUploadError(res.error ?? "Upload failed.");
        return;
      }
      setPreviewState(res.data);
      setStage("preview");
    });
  }

  function onCommit() {
    if (!previewState?.jobId) return;
    startTransition(async () => {
      const res = await commitImportAction(previewState.jobId);
      setCommitState(res);
      setStage("result");
      if (!res.ok) {
        toast.error(res.error ?? "Commit failed.", {
          duration: Infinity,
          dismissible: true,
        });
      } else {
        toast.success("Import committed.");
      }
    });
  }

  function onCancel() {
    if (!previewState?.jobId) {
      setStage("upload");
      setPreviewState(null);
      return;
    }
    startTransition(async () => {
      await cancelImportAction(previewState.jobId);
      setStage("upload");
      setPreviewState(null);
    });
  }

  return (
    <div>
      {stage === "upload" ? (
        <UploadForm
          pending={pending}
          uploadError={uploadError}
          onSubmit={onUpload}
        />
      ) : null}
      {stage === "preview" && previewState?.preview ? (
        <PreviewView
          preview={previewState.preview}
          fileName={previewState.fileName}
          smartDetect={previewState.smartDetect}
          pending={pending}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      ) : null}
      {stage === "result" && commitState ? (
        <ResultView state={commitState} />
      ) : null}
    </div>
  );
}

function UploadForm({
  pending,
  uploadError,
  onSubmit,
}: {
  pending: boolean;
  uploadError: string | null;
  onSubmit: (fd: FormData) => void;
}) {
  return (
    <form
      action={onSubmit}
      className="mt-8 flex flex-col gap-4 rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-4">
        <label className="flex-1 text-xs uppercase tracking-wide text-muted-foreground">
          Upload .xlsx file
          <input
            type="file"
            name="file"
            accept=".xlsx"
            required
            className="mt-2 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
          />
        </label>
        <Link
          href="/api/leads/import-template"
          className="self-end rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground/90 transition hover:bg-muted"
        >
          Download template (.xlsx)
        </Link>
      </div>

      <label className="flex items-start gap-2 text-xs text-foreground/80">
        <input type="checkbox" name="smartDetect" className="mt-0.5" />
        <span>
          <span className="font-medium text-foreground/90">
            Detect and parse legacy D365 Description column
          </span>
          <br />
          If your file has Phone Calls, Notes, Topic, or Linked Opportunity
          data crammed into the Description column, enable this to extract
          them automatically. New imports should use the dedicated columns
          instead.
        </span>
      </label>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Parsing…" : "Preview import"}
      </button>

      {uploadError ? (
        <p className="text-sm text-[var(--status-lost-fg)]">{uploadError}</p>
      ) : null}
    </form>
  );
}

function PreviewView({
  preview,
  fileName,
  smartDetect,
  pending,
  onCommit,
  onCancel,
}: {
  preview: PreviewSuccessData["preview"];
  fileName: string;
  smartDetect: boolean;
  pending: boolean;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground/80">
          Import preview
        </p>
        <h2 className="mt-1 text-xl font-semibold text-foreground">
          {fileName}{" "}
          <span className="text-muted-foreground">({preview.totalRows} rows)</span>
        </h2>
        {smartDetect ? (
          <p className="mt-2 text-xs text-[var(--status-qualification-fg)]">
            ☑ Legacy D365 Description column detection is enabled.
          </p>
        ) : null}
      </div>

      <Section title="Records">
        <Stat label="New leads" value={preview.newLeadCount} tone="ok" />
        <Stat
          label="Existing leads to update"
          value={preview.updatedLeadCount}
          tone="ok"
        />
        <Stat
          label="Rows skipped"
          value={preview.skippedRowCount}
          tone={preview.skippedRowCount > 0 ? "danger" : "neutral"}
        />
      </Section>

      <Section title="Activities">
        <Stat label="Subjects to set" value={preview.subjectsToSet} />
        <Stat label="Phone calls" value={preview.callActivitiesToCreate} />
        <Stat label="Meetings" value={preview.meetingActivitiesToCreate} />
        <Stat label="Notes" value={preview.noteActivitiesToCreate} />
        <Stat label="Emails" value={preview.emailActivitiesToCreate} />
      </Section>

      <Section title="Opportunities">
        <Stat
          label="To create"
          value={preview.opportunitiesToCreate}
          tone="ok"
        />
      </Section>

      {preview.warnings.length > 0 ? (
        <CollapsibleList
          title={`Warnings (${preview.warnings.length})`}
          tone="warn"
          items={preview.warnings.map((w) => ({
            primary: w.message,
            secondary:
              w.rows.length > 0 ? `Rows: ${w.rows.slice(0, 25).join(", ")}${w.rows.length > 25 ? `, +${w.rows.length - 25} more` : ""}` : null,
          }))}
        />
      ) : null}

      {preview.errors.length > 0 ? (
        <CollapsibleList
          title={`Errors — ${preview.errors.length} ${preview.errors.length === 1 ? "row" : "rows"} skipped`}
          tone="danger"
          items={preview.errors.map((e) => ({
            primary: `Row ${e.rowNumber}`,
            secondary: e.errors.join(" · "),
          }))}
        />
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/90 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={pending}
          className="rounded-md bg-emerald-300/90 px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Committing…" : "Commit import"}
        </button>
      </div>
    </div>
  );
}

function ResultView({
  state,
}: {
  state: ActionResult<CommitSuccessData>;
}) {
  if (!state.ok) {
    return (
      <div className="mt-8 rounded-2xl border border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium text-rose-700 dark:text-rose-100">Import failed</h2>
        <p className="mt-2 text-sm text-rose-700 dark:text-rose-100/80">{state.error}</p>
      </div>
    );
  }
  const r = state.data.result;
  return (
    <div className="mt-8 rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Import committed
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="New leads" value={r.insertedLeadIds.length} />
        <Stat label="Updated" value={r.updatedLeadIds.length} />
        <Stat label="Activities" value={r.insertedActivityCount} />
        <Stat
          label="Activities skipped (dedup)"
          value={r.skippedActivityCount}
        />
        <Stat label="Opportunities" value={r.insertedOpportunityIds.length} />
        <Stat
          label="Failed rows"
          value={r.failedRows.length}
          tone={r.failedRows.length > 0 ? "danger" : "neutral"}
        />
      </div>

      {r.failedRows.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-xs uppercase tracking-wide text-rose-700 dark:text-rose-200">
            Failed rows
          </h3>
          <ul className="mt-2 divide-y divide-border/60 text-xs">
            {r.failedRows.map((f, i) => (
              <li key={i} className="py-2 text-foreground/80">
                Row {f.rowNumber}: {f.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Link
        href="/leads"
        className="mt-6 inline-block rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/90 transition hover:bg-muted"
      >
        View leads
      </Link>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "danger" | "neutral";
}) {
  const ring =
    tone === "danger"
      ? "border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 text-rose-700 dark:text-rose-100"
      : tone === "warn"
        ? "border-amber-500/30 dark:border-amber-300/30 bg-amber-500/20 dark:bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-100"
        : tone === "ok"
          ? "border-emerald-500/30 dark:border-emerald-300/30 bg-emerald-500/20 dark:bg-emerald-500/15 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-100"
          : "border-border bg-muted/40 text-foreground/90";
  return (
    <div className={`rounded-xl border px-4 py-3 ${ring}`}>
      <p className="text-[10px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function CollapsibleList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "warn" | "danger";
  items: Array<{ primary: string; secondary: string | null }>;
}) {
  const ring =
    tone === "danger"
      ? "border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 text-rose-700 dark:text-rose-100"
      : "border-amber-500/30 dark:border-amber-300/30 bg-amber-500/20 dark:bg-amber-500/15 dark:bg-amber-500/10 text-amber-700 dark:text-amber-100";
  return (
    <details className={`rounded-2xl border ${ring} p-4 backdrop-blur-xl`}>
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <ul className="mt-3 max-h-72 overflow-y-auto divide-y divide-border/60 text-xs">
        {items.map((it, i) => (
          <li key={i} className="py-2">
            <p className="text-foreground/90">{it.primary}</p>
            {it.secondary ? (
              <p className="mt-1 text-muted-foreground">{it.secondary}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
