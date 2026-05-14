"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useShowPicker } from "@/hooks/use-show-picker";
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
import { configFor, SECTION_ORDER, type FieldConfig } from "./field-config";

/**
 * Batch review split-pane.
 *
 * Left: scrollable record list with bulk actions + per-row status, summary,
 * warning / conflict / default-owner badges.
 *
 * Right: tabbed detail
 *   - Mapped fields: section-grouped, type-aware inputs, side-by-side D365 source
 *   - Raw D365 payload: JSON viewer
 *   - Custom fields: D365 custom-field passthrough (preserved as `metadata`)
 *   - Activities: child records (notes, tasks, calls, appointments, emails)
 *
 * Bottom: Commit batch + Save & exit.
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
  customFields: Record<string, unknown>;
  validationWarnings: ValidationWarning[];
  conflictResolution: ConflictResolution | null;
  conflictWith: string | null;
  resolvedFromDefaultOwner: boolean;
  summary: {
    primary: string;
    secondary?: string | null;
    tertiary?: string | null;
  };
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
          // key={selected.id} resets all child useState defaults
          // (tab, reject-reason draft, conflict-picker value, mapped
          // fields editor draft) when the user clicks a different
          // record in the left list. Without this, draft state bleeds
          // across records and the editor inputs show stale data.
          <RecordDetail key={selected.id} record={selected} readOnly={readOnly} />
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
 * Left pane *
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
              // Approve only rows that either have no conflict, or have a
              // conflict with an explicit resolution selected. (Previously
              // an OR-bug let unresolved conflicts through.)
              bulkApprove(
                (r) => !r.conflictWith || r.conflictResolution !== null,
              )
            }
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted/60 disabled:opacity-50"
          >
            Approve resolved
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
                  {r.children && r.children.length > 0 ? (
                    <Badge tone="info">
                      {r.children.length} activit{r.children.length === 1 ? "y" : "ies"}
                    </Badge>
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
 * Right pane *
 * -------------------------------------------------------------------------- */

type DetailTab = "mapped" | "raw" | "custom" | "activities";

function RecordDetail({
  record,
  readOnly,
}: {
  record: BatchRecordView;
  readOnly: boolean;
}) {
  const [tab, setTab] = useState<DetailTab>("mapped");
  const hasChildren = (record.children?.length ?? 0) > 0;
  const hasCustom = Object.keys(record.customFields).length > 0;

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          {record.sourceEntityType}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {record.sourceId}
        </span>
        <RecordStatusIcon status={record.status} />
        {record.error ? (
          <span className="text-[11px] text-destructive">{record.error}</span>
        ) : null}
      </div>

      <div className="flex border-b border-border text-xs">
        {(["mapped", "raw", "custom", "activities"] as DetailTab[]).map((t) => {
          if (t === "activities" && !hasChildren) return null;
          if (t === "custom" && !hasCustom) return null;
          const label =
            t === "mapped"
              ? "Mapped fields"
              : t === "raw"
                ? "Raw D365 payload"
                : t === "custom"
                  ? `Custom fields (${Object.keys(record.customFields).length})`
                  : `Activities (${record.children?.length ?? 0})`;
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
              {label}
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
        ) : tab === "custom" ? (
          <CustomFieldsView fields={record.customFields} />
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

/* -------------------------------------------------------------------------- *
 * Mapped fields editor — section-grouped, type-aware *
 * -------------------------------------------------------------------------- */

function MappedFieldsEditor({
  record,
  readOnly,
}: {
  record: BatchRecordView;
  readOnly: boolean;
}) {
  const config = configFor(record.sourceEntityType);
  const initial = record.mappedPayload ?? {};
  const [draft, setDraft] = useState<Record<string, unknown>>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const warningsByField = new Map<string, ValidationWarning[]>();
  for (const w of record.validationWarnings) {
    const arr = warningsByField.get(w.field) ?? [];
    arr.push(w);
    warningsByField.set(w.field, arr);
  }

  // Build per-section lists. Fields in config are listed in their declared
  // order; "Other" gets every key from `draft` that isn't in the config
  // (including `_meta` etc., which we hide via the underscore check).
  const configByName = new Map(config.map((f) => [f.name, f]));
  const sections = new Map<string, FieldConfig[]>();
  for (const f of config) {
    const list = sections.get(f.section) ?? [];
    list.push(f);
    sections.set(f.section, list);
  }
  const otherKeys = Object.keys(draft).filter(
    (k) => !configByName.has(k) && !k.startsWith("_"),
  );
  if (otherKeys.length > 0) {
    sections.set(
      "Other",
      otherKeys.map<FieldConfig>((name) => ({
        name,
        label: name,
        section: "Other",
        type: inferTypeFromValue(draft[name]),
      })),
    );
  }

  function setField(name: string, value: unknown) {
    setDraft((prev) => ({ ...prev, [name]: value }));
    setSaved(false);
  }

  function onSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("recordId", record.id);
      fd.set("mappedPayloadJson", JSON.stringify(draft));
      const res = await editRecordFieldsAction(fd);
      if (!res.ok) setError(res.error);
      else setSaved(true);
    });
  }

  if (Object.keys(draft).length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No mapped payload yet. The mapper has not produced output for this record.
      </p>
    );
  }

  const orderedSections = SECTION_ORDER.filter((s) => sections.has(s));
  return (
    <div className="space-y-5">
      {orderedSections.map((sectionName) => {
        const fields = sections.get(sectionName) ?? [];
        return (
          <section key={sectionName} className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              {sectionName}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <FieldRow
                  key={f.name}
                  field={f}
                  value={draft[f.name]}
                  sourceValue={resolveSource(record.rawPayload, f.sources)}
                  warnings={warningsByField.get(f.name)}
                  readOnly={readOnly || f.readOnly === true}
                  onChange={(v) => setField(f.name, v)}
                />
              ))}
            </div>
          </section>
        );
      })}
      {!readOnly ? (
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={onSave}
            disabled={pending}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save edits"}
          </button>
          {saved ? (
            <span className="text-[11px] text-[var(--status-won-fg)]">Saved.</span>
          ) : null}
          {error ? (
            <span className="text-[11px] text-destructive">{error}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FieldRow({
  field,
  value,
  sourceValue,
  warnings,
  readOnly,
  onChange,
}: {
  field: FieldConfig;
  value: unknown;
  sourceValue: string | null;
  warnings: ValidationWarning[] | undefined;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="flex items-baseline justify-between gap-2 text-muted-foreground">
        <span className="font-medium text-foreground">{field.label}</span>
        {field.sources && field.sources.length > 0 ? (
          <span
            className="truncate font-mono text-[10px] text-muted-foreground/60"
            title={`D365: ${field.sources.join(" / ")}`}
          >
            {field.sources[0]}
            {sourceValue !== null ? ` = ${truncate(sourceValue, 24)}` : ""}
          </span>
        ) : null}
      </span>
      <FieldInput
        type={field.type}
        value={value}
        readOnly={readOnly}
        onChange={onChange}
      />
      {warnings?.map((w) => (
        <span
          key={`${field.name}-${w.code}`}
          className="flex items-center gap-1 text-[10px] text-[var(--status-proposal-fg)]"
        >
          <TriangleAlert className="h-3 w-3" />
          {w.message}
        </span>
      ))}
    </label>
  );
}

function FieldInput({
  type,
  value,
  readOnly,
  onChange,
}: {
  type: FieldConfig["type"];
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const datePicker = useShowPicker();
  const baseInput =
    "rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-70";

  if (type === "boolean") {
    return (
      <input
        type="checkbox"
        disabled={readOnly}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border border-border bg-background text-primary focus:ring-ring/40 disabled:opacity-70"
      />
    );
  }
  if (type === "date") {
    // Accept either an ISO timestamp (D365 createdon) or YYYY-MM-DD.
    const dateValue =
      typeof value === "string"
        ? value.length >= 10
          ? value.slice(0, 10)
          : value
        : value instanceof Date
          ? value.toISOString().slice(0, 10)
          : "";
    return (
      <input
        type="date"
        disabled={readOnly}
        value={dateValue}
        onChange={(e) => onChange(e.target.value || null)}
        onClick={datePicker}
        className={baseInput}
      />
    );
  }
  if (type === "number") {
    return (
      <input
        type="number"
        disabled={readOnly}
        value={value == null ? "" : Number(value)}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
        className={baseInput}
      />
    );
  }
  if (type === "long_text") {
    return (
      <textarea
        disabled={readOnly}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || null)}
        rows={3}
        className={cn(baseInput, "resize-y")}
      />
    );
  }
  if (type === "uuid_ref") {
    return (
      <input
        type="text"
        disabled={readOnly}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder="uuid"
        className={cn(baseInput, "font-mono")}
      />
    );
  }
  // text
  return (
    <input
      type="text"
      disabled={readOnly}
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value || null)}
      className={baseInput}
    />
  );
}

function inferTypeFromValue(v: unknown): FieldConfig["type"] {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
  return "text";
}

function resolveSource(
  raw: Record<string, unknown>,
  sources: string[] | undefined,
): string | null {
  if (!sources || sources.length === 0) return null;
  for (const s of sources) {
    const v = raw[s];
    if (v === null || v === undefined) continue;
    if (typeof v === "string") return v.length > 0 ? v : null;
    return String(v);
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* -------------------------------------------------------------------------- *
 * Custom fields panel *
 * -------------------------------------------------------------------------- */

function CustomFieldsView({ fields }: { fields: Record<string, unknown> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No custom fields.</p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">
        D365 custom fields preserved as <code>metadata</code> on the imported row.
      </p>
      <div className="overflow-hidden rounded border border-border">
        <table className="w-full text-xs">
          <tbody className="divide-y divide-border">
            {entries.map(([key, val]) => (
              <tr key={key} className="bg-background">
                <td className="border-r border-border px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {key}
                </td>
                <td className="px-2 py-1 font-mono text-[11px] text-foreground">
                  {val === null || val === undefined
                    ? "—"
                    : typeof val === "object"
                      ? JSON.stringify(val)
                      : String(val)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Children list (attached activities) *
 * -------------------------------------------------------------------------- */

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
          {c.sourceId ? (
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {c.sourceId}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- *
 * Decision + conflict + footer (unchanged behavior) *
 * -------------------------------------------------------------------------- */

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
        className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
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
            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
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
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
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
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
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
