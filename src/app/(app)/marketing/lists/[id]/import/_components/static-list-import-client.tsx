"use client";

import Link from "next/link";
import { useState } from "react";
import { ImportWizard } from "@/components/import/import-wizard";
import type { ImportWizardConfig } from "@/components/import/types";
import {
  cancelStaticListImportAction,
  commitStaticListImportAction,
  previewStaticListImportAction,
  type CommitStaticListImportData,
  type PreviewStaticListImportData,
} from "../actions";
import type { ActionResult } from "@/lib/server-action";

interface ResumableRun {
  id: string;
  fileName: string;
  totalRows: number;
  successfulRows: number;
  invalidRows: number;
  duplicateRows: number;
}

/**
 * Thin shell that wires the generic `<ImportWizard>` to
 * the static-list import actions.
 *
 * If a `resumable` run is passed, the user sees a banner offering to
 * resume that run; clicking through auto-loads the persisted preview
 * via the wizard's `resumeRunId` prop. Otherwise the standard upload
 * form is rendered.
 */
export function StaticListImportClient({
  listId,
  resumable,
}: {
  listId: string;
  resumable: ResumableRun | null;
}) {
  const [resumeRunId, setResumeRunId] = useState<string | null>(null);
  const [resumableState, setResumableState] = useState<ResumableRun | null>(
    resumable,
  );

  const config: ImportWizardConfig<
    PreviewStaticListImportData,
    CommitStaticListImportData
  > = {
    destinationLabel: "List members",
    previewAction: (formData: FormData) =>
      previewStaticListImportAction(listId, formData),
    commitAction: commitStaticListImportAction,
    cancelAction: async (runId: string) => {
      const res = await cancelStaticListImportAction(runId);
      // If the cancelled run was the resume target, clear the banner.
      setResumableState(null);
      setResumeRunId(null);
      return res;
    },
    successToastMessage: "Recipients imported.",
    renderUploadExtras:
      resumableState && !resumeRunId
        ? () => (
            <ResumeBanner
              run={resumableState}
              onResume={() => setResumeRunId(resumableState.id)}
              onDiscard={async () => {
                await cancelStaticListImportAction(resumableState.id);
                setResumableState(null);
              }}
            />
          )
        : undefined,
    renderPreview: ({ preview, pending, onCommit, onCancel }) => (
      <StaticPreviewView
        preview={preview}
        pending={pending}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    ),
    renderResult: ({ state }) => (
      <StaticResultView listId={listId} state={state} />
    ),
  };

  return (
    <ImportWizard
      key={resumeRunId ?? "fresh"}
      config={config}
      resumeRunId={resumeRunId ?? undefined}
    />
  );
}

function ResumeBanner({
  run,
  onResume,
  onDiscard,
}: {
  run: ResumableRun;
  onResume: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-4 text-sm">
      <p className="text-foreground/90">
        <span className="font-medium">In-progress import:</span> {run.fileName} —{" "}
        {run.totalRows} {run.totalRows === 1 ? "row" : "rows"} queued (
        {run.successfulRows} new, {run.duplicateRows} duplicates,{" "}
        {run.invalidRows} invalid).
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onResume}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          Resume import
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground/90 transition hover:bg-muted"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function StaticPreviewView({
  preview,
  pending,
  onCommit,
  onCancel,
}: {
  preview: PreviewStaticListImportData;
  pending: boolean;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const detectLine = preview.smartDetect.confident
    ? `Detected email column ${preview.smartDetect.emailColumn} and name column ${preview.smartDetect.nameColumn}.`
    : preview.smartDetect.emailColumn !== null
      ? `Detected email column ${preview.smartDetect.emailColumn}. No name column found — names will be left blank.`
      : null;

  const unknownHeaders = preview.smartDetect.unknownHeaders;

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
        <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground/80">
          Import preview
        </p>
        <h2 className="mt-1 text-xl font-semibold text-foreground">
          {preview.fileName}{" "}
          <span className="text-muted-foreground">
            ({preview.totalRows} {preview.totalRows === 1 ? "row" : "rows"})
          </span>
        </h2>
        {detectLine ? (
          <p className="mt-2 text-xs text-muted-foreground">{detectLine}</p>
        ) : null}
        {unknownHeaders.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Ignored {unknownHeaders.length}{" "}
            {unknownHeaders.length === 1 ? "header" : "headers"}:{" "}
            {unknownHeaders.slice(0, 6).join(", ")}
            {unknownHeaders.length > 6
              ? `, +${unknownHeaders.length - 6} more`
              : ""}
            .
          </p>
        ) : null}
        {preview.resumed ? (
          <p className="mt-2 text-xs text-[var(--status-qualification-fg)]">
            Resumed from a previous in-progress import.
          </p>
        ) : null}
      </div>

      <Section title="Recipients">
        <Stat label="New" value={preview.successfulRows} tone="ok" />
        <Stat
          label="Duplicates"
          value={preview.duplicateRows}
          tone={preview.duplicateRows > 0 ? "warn" : "neutral"}
        />
        <Stat
          label="Invalid"
          value={preview.invalidRows}
          tone={preview.invalidRows > 0 ? "danger" : "neutral"}
        />
        <Stat label="Total rows" value={preview.totalRows} />
      </Section>

      {preview.errors.length > 0 ? (
        <CollapsibleList
          title={`Errors — ${preview.errors.length} ${preview.errors.length === 1 ? "row" : "rows"} flagged`}
          tone="danger"
          items={preview.errors.map((e) => ({
            primary: `Row ${e.row}`,
            secondary: e.message,
          }))}
        />
      ) : null}

      {preview.successfulRows > 0 ? (
        <CollapsibleList
          title={`Sample recipients (${Math.min(preview.successfulRows, 25)} of ${preview.successfulRows})`}
          tone="ok"
          items={preview.preview
            .filter((r) => r.status === "ok")
            .slice(0, 25)
            .map((r) => ({
              primary: r.email,
              secondary: r.name ?? null,
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
          disabled={pending || preview.successfulRows === 0}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending
            ? "Importing…"
            : `Import ${preview.successfulRows} recipients`}
        </button>
      </div>
    </div>
  );
}

function StaticResultView({
  listId,
  state,
}: {
  listId: string;
  state: ActionResult<CommitStaticListImportData>;
}) {
  if (!state.ok) {
    return (
      <div className="mt-8 rounded-2xl border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium text-[var(--status-lost-fg)]">
          Import failed
        </h2>
        <p className="mt-2 text-sm text-[var(--status-lost-fg)]/80">
          {state.error}
        </p>
      </div>
    );
  }
  const r = state.data;
  return (
    <div className="mt-8 rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Import committed
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Recipients added" value={r.inserted} tone="ok" />
        <Stat
          label="Skipped"
          value={r.skipped}
          tone={r.skipped > 0 ? "warn" : "neutral"}
        />
        <Stat
          label="Failed"
          value={r.failed}
          tone={r.failed > 0 ? "danger" : "neutral"}
        />
        <Stat label="Total rows" value={r.total} />
      </div>
      <Link
        href={`/marketing/lists/${listId}`}
        className="mt-6 inline-block rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/90 transition hover:bg-muted"
      >
        Back to list
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
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
        {children}
      </div>
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
      ? "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]"
      : tone === "warn"
        ? "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]"
        : tone === "ok"
          ? "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]"
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
  tone: "ok" | "warn" | "danger";
  items: Array<{ primary: string; secondary: string | null }>;
}) {
  const ring =
    tone === "danger"
      ? "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]"
      : tone === "warn"
        ? "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]"
        : "border-[var(--status-won-fg)]/30 bg-[var(--status-won-bg)] text-[var(--status-won-fg)]";
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
