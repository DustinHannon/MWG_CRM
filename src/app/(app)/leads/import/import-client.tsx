"use client";

import Link from "next/link";
import { ImportWizard } from "@/components/import/import-wizard";
import type { ImportWizardConfig } from "@/components/import/types";
import {
  cancelImportAction,
  commitImportAction,
  previewImportAction,
  type CommitSuccessData,
  type PreviewSuccessData,
} from "./actions";
import type { ActionResult } from "@/lib/server-action";

/**
 * Phase 29 §6 — Thin shell that wires the generic `<ImportWizard>` to
 * the leads-specific preview / commit / cancel actions and renders the
 * leads-specific preview + result panes. The visible behavior is
 * unchanged from the original Phase 6E wizard; only the surrounding
 * state machine has moved to `@/components/import/import-wizard.tsx`.
 */
export function ImportClient() {
  const config: ImportWizardConfig<PreviewSuccessData, CommitSuccessData> = {
    destinationLabel: "Leads",
    templateDownloadUrl: "/api/leads/import-template",
    previewAction: previewImportAction,
    commitAction: commitImportAction,
    cancelAction: cancelImportAction,
    successToastMessage: "Import committed.",
    renderUploadFormExtras: () => (
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
    ),
    renderPreview: ({ preview, pending, onCommit, onCancel }) => (
      <LeadPreviewView
        previewData={preview}
        pending={pending}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    ),
    renderResult: ({ state }) => <LeadResultView state={state} />,
  };

  return <ImportWizard config={config} />;
}

function LeadPreviewView({
  previewData,
  pending,
  onCommit,
  onCancel,
}: {
  previewData: PreviewSuccessData;
  pending: boolean;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const preview = previewData.preview;
  const fileName = previewData.fileName;
  const smartDetect = previewData.smartDetect;

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
              w.rows.length > 0
                ? `Rows: ${w.rows.slice(0, 25).join(", ")}${w.rows.length > 25 ? `, +${w.rows.length - 25} more` : ""}`
                : null,
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
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Committing…" : "Commit import"}
        </button>
      </div>
    </div>
  );
}

function LeadResultView({
  state,
}: {
  state: ActionResult<CommitSuccessData>;
}) {
  if (!state.ok) {
    return (
      <div className="mt-8 rounded-2xl border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] p-6 backdrop-blur-xl">
        <h2 className="text-sm font-medium text-[var(--status-lost-fg)]">Import failed</h2>
        <p className="mt-2 text-sm text-[var(--status-lost-fg)]/80">{state.error}</p>
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
          <h3 className="text-xs uppercase tracking-wide text-[var(--status-lost-fg)]">
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
  tone: "warn" | "danger";
  items: Array<{ primary: string; secondary: string | null }>;
}) {
  const ring =
    tone === "danger"
      ? "border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]"
      : "border-[var(--priority-medium-fg)]/30 bg-[var(--priority-medium-bg)] text-[var(--priority-medium-fg)]";
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
