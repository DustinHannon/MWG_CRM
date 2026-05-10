"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  GitMerge,
  ShieldCheck,
  Slash,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  approveRecordAction,
  commitBatchAction,
  editRecordFieldsAction,
  rejectRecordAction,
  setConflictResolutionAction,
} from "@/app/admin/d365-import/actions";
import { cn } from "@/lib/utils";

/**
 * Phase 23 — Batch review split-pane component.
 *
 * Left: scrollable record list with bulk actions header + per-row
 * status icons, summary, warning/conflict/default-owner badges.
 *
 * Right: tabbed detail (Mapped fields editor / Raw payload / Activities)
 * with per-record Approve / Reject / Conflict-resolution / Inline edit.
 *
 * Bottom: Commit batch (disabled until every record is approved or
 * rejected) and Save & exit (returns to run detail).
 */

export type RecordStatus =
  | "pending"
  | "mapped"
  | "review"
  | "approved"
  | "rejected"
  | "committed"
  | "skipped"
  | "failed";

export type ConflictResolution =
  | "none"
  | "dedup_skip"
  | "dedup_merge"
  | "dedup_overwrite"
  | "manual_resolved";

export interface ValidationWarning {
  field: string;
  code: string;
  message: string;
}

export interface BatchRecordView {
  id: string;
  sourceEntityType: string;
  sourceId: string;
  status: RecordStatus;
  rawPayload: Record<string, unknown>;
  mappedPayload: Record<string, unknown> | null;
  validationWarnings: ValidationWarning[];
  conflictResolution: ConflictResolution | null;
  conflictWith: string | null;
  /** Q-05 — true when the resolved owner came from the default-owner fallback. */
  resolvedFromDefaultOwner: boolean;
  /** Optional summary fields used by the left-hand list. */
  summary: {
    primary: string;
    secondary?: string | null;
    tertiary?: string | null;
  };
  /** Children attached to a parent entity (notes, activities, etc.). */
  children?: BatchChildView[];
  error: string | null;
}

export interface BatchChildView {
  id: string;
  sourceEntityType: string;
  sourceId: string;
  summary: string;
  status: RecordStatus;
}

interface BatchReviewPaneProps {
  runId: string;
  batchId: string;
  records: BatchRecordView[];
  /** Whether the batch is still open for review (controls submit buttons). */
  readOnly?: boolean;
}

export function BatchReviewPane({
  runId,
  batchId,
  records,
  readOnly = false,
}: BatchReviewPaneProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(
    records[0]?.id ?? null,
  );
  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? null,
    [records, selectedId],
  );

  const allDecided = records.every(
    (r) =>
      r.status === "approved" ||
      r.status === "rejected" ||
      r.status === "committed" ||
      r.status === "skipped" ||
      r.status === "failed",
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <RecordList
        records={records}
        selectedId={selectedId}
        onSelect={setSelectedId}
        readOnly={readOnly}
      />
      <div className="flex flex-col gap-4">
        {selected ? (
          <RecordDetail record={selected} readOnly={readOnly} />
        ) : (
          <div className="rounded-lg border border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
            No records in this batch.
          </div>
        )}

        {!readOnly ? (
          <BatchFooter
            runId={runId}
            batchId={batchId}
            allDecided={allDecided}
            recordCount={records.length}
            onSaveExit={() => router.push(`/admin/d365-import/${runId}`)}
          />
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *                              Left pane                                     *
 * -------------------------------------------------------------------------- */

function RecordList({
  records,
  selectedId,
  onSelect,
  readOnly,
}: {
  records: BatchRecordView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  readOnly: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function bulkApprove(filter: (r: BatchRecordView) => boolean) {
    startTransition(async () => {
      for (const r of records.filter(filter)) {
        if (r.status === "approved") continue;
        const fd = new FormData();
        fd.set("recordId", r.id);
        await approveRecordAction(fd);
      }
    });
  }

  function bulkReject() {
    startTransition(async () => {
      for (const r of records) {
        if (r.status === "rejected") continue;
        const fd = new FormData();
        fd.set("recordId", r.id);
        await rejectRecordAction(fd);
      }
    });
  }

  return (
    <div className="flex max-h-[70vh] flex-col rounded-lg border border-border bg-muted/30">
      {!readOnly ? (
        <div className="flex flex-wrap gap-1 border-b border-border bg-background/40 p-2 text-[11px]">
          <button
            type="button"
            disabled={pending}
            onClick={() => bulkApprove((r) => r.validationWarnings.length === 0)}
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted/60 disabled:opacity-50"
          >
            Approve all (no warnings)
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              bulkApprove((r) => !r.conflictWith || r.conflictResolution !== null)
            }
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted/60 disabled:opacity-50"
          >
            Approve without conflicts
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={bulkReject}
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted/60 disabled:opacity-50"
          >
            Reject all
          </button>
        </div>
      ) : null}
      <ul className="flex-1 overflow-y-auto">
        {records.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r.id)}
              className={cn(
                "flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left text-xs hover:bg-muted/40",
                selectedId === r.id && "bg-muted/60",
              )}
            >
              <RecordStatusIcon status={r.status} />
              <div className="grow truncate">
                <div className="truncate font-medium text-foreground">
                  {r.summary.primary}
                </div>
                {r.summary.secondary ? (
                  <div className="truncate text-muted-foreground">
                    {r.summary.secondary}
                  </div>
                ) : null}
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.validationWarnings.length > 0 ? (
                    <Badge tone="warn">
                      {r.validationWarnings.length} warning
                      {r.validationWarnings.length === 1 ? "" : "s"}
                    </Badge>
                  ) : null}
                  {r.conflictWith ? <Badge tone="conflict">Conflict</Badge> : null}
                  {r.resolvedFromDefaultOwner ? (
                    <Badge tone="info">Default owner</Badge>
                  ) : null}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecordStatusIcon({ status }: { status: RecordStatus }) {
  if (status === "approved")
    return (
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-won-fg)]" />
    );
  if (status === "rejected")
    return (
      <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-lost-fg)]" />
    );
  if (status === "committed")
    return (
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-won-fg)]" />
    );
  if (status === "skipped")
    return (
      <Slash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    );
  if (status === "failed")
    return (
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
    );
  // pending / mapped / review
  return (
    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--status-default-fg)]/60" />
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "warn" | "conflict" | "info";
  children: React.ReactNode;
}) {
  const cls =
    tone === "warn"
      ? "bg-[var(--status-proposal-bg)] text-[var(--status-proposal-fg)]"
      : tone === "conflict"
        ? "bg-[var(--status-lost-bg)] text-[var(--status-lost-fg)]"
        : "bg-[var(--status-default-bg)] text-[var(--status-default-fg)]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1 py-0 text-[10px] font-medium leading-tight",
        cls,
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 *                              Right pane                                    *
 * -------------------------------------------------------------------------- */

type DetailTab = "mapped" | "raw" | "activities";

function RecordDetail({
  record,
  readOnly,
}: {
  record: BatchRecordView;
  readOnly: boolean;
}) {
  const [tab, setTab] = useState<DetailTab>("mapped");
  const hasChildren = (record.children?.length ?? 0) > 0;

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          {record.sourceEntityType}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {record.sourceId}
        </span>
        <RecordStatusIcon status={record.status} />
      </div>

      <div className="flex border-b border-border text-xs">
        {(["mapped", "raw", "activities"] as DetailTab[]).map((t) => {
          if (t === "activities" && !hasChildren) return null;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 hover:bg-muted/40",
                tab === t
                  ? "border-b-2 border-foreground/60 font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {t === "mapped"
                ? "Mapped fields"
                : t === "raw"
                  ? "Raw D365 payload"
                  : `Activities (${record.children?.length ?? 0})`}
            </button>
          );
        })}
      </div>

      <div className="p-4">
        {tab === "mapped" ? (
          <MappedFieldsEditor record={record} readOnly={readOnly} />
        ) : tab === "raw" ? (
          <pre className="max-h-[60vh] overflow-auto rounded bg-muted/50 p-3 text-[11px] leading-relaxed text-foreground">
            {JSON.stringify(record.rawPayload, null, 2)}
          </pre>
        ) : (
          <ChildrenList items={record.children ?? []} />
        )}
      </div>

      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/20 p-3">
          <DecisionButtons recordId={record.id} status={record.status} />
          {record.conflictWith ? (
            <ConflictResolutionPicker
              recordId={record.id}
              current={record.conflictResolution}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MappedFieldsEditor({
  record,
  readOnly,
}: {
  record: BatchRecordView;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(
    record.mappedPayload ?? {},
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const fields = Object.keys(draft);

  function onSave() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("recordId", record.id);
      fd.set("mappedPayloadJson", JSON.stringify(draft));
      const res = await editRecordFieldsAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  if (fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No mapped payload yet. The mapper has not produced output for this
        record.
      </p>
    );
  }

  const warningsByField = new Map<string, ValidationWarning[]>();
  for (const w of record.validationWarnings) {
    const arr = warningsByField.get(w.field) ?? [];
    arr.push(w);
    warningsByField.set(w.field, arr);
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((field) => {
          const value = draft[field];
          const sourceField = (record.rawPayload[field] ?? "") as string;
          const warns = warningsByField.get(field);
          return (
            <label key={field} className="flex flex-col gap-1 text-xs">
              <span className="flex items-center gap-2 text-muted-foreground">
                <span className="font-medium text-foreground">{field}</span>
                <span className="text-[10px] text-muted-foreground/60">
                  {String(sourceField).slice(0, 40)}
                </span>
              </span>
              <input
                type="text"
                disabled={readOnly}
                value={value == null ? "" : String(value)}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, [field]: e.target.value }))
                }
                className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
              {warns?.map((w) => (
                <span
                  key={`${field}-${w.code}`}
                  className="flex items-center gap-1 text-[10px] text-[var(--status-proposal-fg)]"
                >
                  <TriangleAlert className="h-3 w-3" />
                  {w.message}
                </span>
              ))}
            </label>
          );
        })}
      </div>
      {!readOnly ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            disabled={pending}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save edits"}
          </button>
          {error ? (
            <span className="text-[11px] text-destructive">{error}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChildrenList({ items }: { items: BatchChildView[] }) {
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No child activities attached to this record.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((c) => (
        <li
          key={c.id}
          className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1.5 text-xs"
        >
          <RecordStatusIcon status={c.status} />
          <span className="font-medium text-foreground">{c.sourceEntityType}</span>
          <span className="grow truncate text-muted-foreground">{c.summary}</span>
          <ChildDecisionButtons recordId={c.id} status={c.status} />
        </li>
      ))}
    </ul>
  );
}

function ChildDecisionButtons({
  recordId,
  status,
}: {
  recordId: string;
  status: RecordStatus;
}) {
  const [pending, startTransition] = useTransition();

  function approve() {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("recordId", recordId);
      await approveRecordAction(fd);
    });
  }
  function reject() {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("recordId", recordId);
      await rejectRecordAction(fd);
    });
  }

  if (status === "committed" || status === "skipped" || status === "failed") {
    return null;
  }
  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={approve}
        disabled={pending || status === "approved"}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-muted/60 disabled:opacity-50"
      >
        Approve
      </button>
      <button
        type="button"
        onClick={reject}
        disabled={pending || status === "rejected"}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] hover:bg-muted/60 disabled:opacity-50"
      >
        Reject
      </button>
    </div>
  );
}

function DecisionButtons({
  recordId,
  status,
}: {
  recordId: string;
  status: RecordStatus;
}) {
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function approve() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("recordId", recordId);
      const res = await approveRecordAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("recordId", recordId);
      if (reason.trim()) fd.set("reason", reason.trim());
      const res = await rejectRecordAction(fd);
      if (!res.ok) setError(res.error);
      else {
        setReason("");
        setShowReason(false);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={approve}
        disabled={pending || status === "approved"}
        className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
      >
        <Check className="h-3 w-3" />
        {status === "approved" ? "Approved" : "Approve"}
      </button>
      {!showReason ? (
        <button
          type="button"
          onClick={() => setShowReason(true)}
          disabled={pending || status === "rejected"}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          <X className="h-3 w-3" />
          {status === "rejected" ? "Rejected" : "Reject"}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
            maxLength={500}
          />
          <button
            type="button"
            onClick={reject}
            disabled={pending}
            className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            Confirm reject
          </button>
          <button
            type="button"
            onClick={() => {
              setShowReason(false);
              setReason("");
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted/60"
          >
            Cancel
          </button>
        </div>
      )}
      {error ? <span className="text-[11px] text-destructive">{error}</span> : null}
    </div>
  );
}

function ConflictResolutionPicker({
  recordId,
  current,
}: {
  recordId: string;
  current: ConflictResolution | null;
}) {
  const [value, setValue] = useState<ConflictResolution>(current ?? "dedup_merge");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onChange(v: ConflictResolution) {
    setValue(v);
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("recordId", recordId);
      fd.set("resolution", v);
      const res = await setConflictResolutionAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  const options: Array<{ value: ConflictResolution; label: string }> = [
    { value: "dedup_skip", label: "Skip" },
    { value: "dedup_overwrite", label: "Overwrite" },
    { value: "dedup_merge", label: "Merge" },
    { value: "manual_resolved", label: "Manual (already merged)" },
  ];

  return (
    <div className="ml-auto flex items-center gap-2 text-xs">
      <GitMerge className="h-3 w-3 text-muted-foreground" />
      <span className="text-muted-foreground">Conflict:</span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as ConflictResolution)}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? <span className="text-destructive">{error}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *                                 Footer                                     *
 * -------------------------------------------------------------------------- */

function BatchFooter({
  runId,
  batchId,
  allDecided,
  recordCount,
  onSaveExit,
}: {
  runId: string;
  batchId: string;
  allDecided: boolean;
  recordCount: number;
  onSaveExit: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function commit() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("batchId", batchId);
      const res = await commitBatchAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/admin/d365-import/${runId}`);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">
        {recordCount} records — {allDecided ? "all decided" : "decisions pending"}
      </div>
      <div className="ml-auto flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSaveExit}
          disabled={pending}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          Save & exit
        </button>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!allDecided || pending}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            Commit batch
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Commit approved records to the CRM?
            </span>
            <button
              type="button"
              onClick={commit}
              disabled={pending}
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {pending ? "Committing…" : "Confirm commit"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground hover:bg-muted/60"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      {error ? (
        <p className="basis-full text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
