"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import type { TimePrefs } from "@/lib/format-time";
import { cn } from "@/lib/utils";

export interface FailureRow {
  id: string;
  queuedAt: string;
  sentAt: string | null;
  fromUserId: string;
  fromUserEmailSnapshot: string;
  fromUserDisplayName: string | null;
  toEmail: string;
  toUserId: string | null;
  feature: string;
  featureRecordId: string | null;
  subject: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  graphMessageId: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  requestId: string | null;
  retryOfId: string | null;
  metadata: Record<string, unknown> | null;
  hasAttachments: boolean;
  attachmentCount: number;
  totalSizeBytes: number | null;
}

const RANGE_OPTIONS: ReadonlyArray<{
  value: "24h" | "7d" | "30d" | "90d";
  label: string;
}> = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const STATUS_OPTIONS: ReadonlyArray<{
  value: "all" | "failed" | "blocked_preflight";
  label: string;
}> = [
  { value: "all", label: "All failures" },
  { value: "failed", label: "Failed (Graph error)" },
  { value: "blocked_preflight", label: "Blocked (preflight)" },
];

export interface EmailFailuresFilters {
  range: "24h" | "7d" | "30d" | "90d";
  status: "all" | "failed" | "blocked_preflight";
  feature: string;
  errorCode: string;
  fromUser: string;
}

const DEFAULT_FILTERS: EmailFailuresFilters = {
  range: "7d",
  status: "all",
  feature: "",
  errorCode: "",
  fromUser: "",
};

interface EmailFailuresListClientProps {
  timePrefs: TimePrefs;
  features: string[];
  errorCodes: string[];
  senders: Array<{ id: string; email: string }>;
  initialFilters: EmailFailuresFilters;
}

export function EmailFailuresListClient({
  timePrefs,
  features,
  errorCodes,
  senders,
  initialFilters,
}: EmailFailuresListClientProps) {
  const [filters, setFilters] = useState<EmailFailuresFilters>(initialFilters);
  const [draft, setDraft] = useState<EmailFailuresFilters>(initialFilters);
  const [selected, setSelected] = useState<FailureRow | null>(null);

  const memoizedFilters = useMemo<EmailFailuresFilters>(
    () => filters,
    [filters],
  );

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      f: EmailFailuresFilters,
    ): Promise<StandardListPagePage<FailureRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      params.set("from", f.range);
      params.set("status", f.status);
      if (f.feature) params.set("feature", f.feature);
      if (f.errorCode) params.set("errorCode", f.errorCode);
      if (f.fromUser) params.set("fromUser", f.fromUser);
      const res = await fetch(
        `/api/admin/email-failures/list?${params.toString()}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        throw new Error(`Could not load email failures (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<FailureRow>;
    },
    [],
  );

  const renderRow = useCallback(
    (row: FailureRow) => (
      <FailureDesktopRow
        row={row}
        timePrefs={timePrefs}
        onSelect={() => setSelected(row)}
      />
    ),
    [timePrefs],
  );

  const renderCard = useCallback(
    (row: FailureRow) => (
      <FailureMobileCard
        row={row}
        timePrefs={timePrefs}
        onSelect={() => setSelected(row)}
      />
    ),
    [timePrefs],
  );

  const applyDraft = () => setFilters(draft);
  const clearFilters = () => {
    setDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
  };
  const filtersAreModified =
    filters.range !== DEFAULT_FILTERS.range ||
    filters.status !== DEFAULT_FILTERS.status ||
    Boolean(filters.feature || filters.errorCode || filters.fromUser);

  const filtersSlot = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        applyDraft();
      }}
      className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3"
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Range
        <select
          value={draft.range}
          onChange={(e) =>
            setDraft({
              ...draft,
              range: e.target.value as EmailFailuresFilters["range"],
            })
          }
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Status
        <select
          value={draft.status}
          onChange={(e) =>
            setDraft({
              ...draft,
              status: e.target.value as EmailFailuresFilters["status"],
            })
          }
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Feature
        <select
          value={draft.feature}
          onChange={(e) => setDraft({ ...draft, feature: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Any</option>
          {features.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Error code
        <select
          value={draft.errorCode}
          onChange={(e) => setDraft({ ...draft, errorCode: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Any</option>
          {errorCodes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Sender
        <select
          value={draft.fromUser}
          onChange={(e) => setDraft({ ...draft, fromUser: e.target.value })}
          className="rounded-md border border-border bg-input px-3 py-1.5 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <option value="">Any</option>
          {senders.map((s) => (
            <option key={s.id} value={s.id}>
              {s.email}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          Apply
        </button>
        {filtersAreModified ? (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
      </div>
    </form>
  );

  return (
    <>
      <StandardListPage<FailureRow, EmailFailuresFilters>
        queryKey={["admin-email-failures"]}
        fetchPage={fetchPage}
        filters={memoizedFilters}
        renderRow={renderRow}
        renderCard={renderCard}
        rowEstimateSize={72}
        cardEstimateSize={160}
        pageSize={100}
        emptyState={
          <StandardEmptyState
            title="No email failures match"
            description={
              filtersAreModified ? "Reset the filters to see all failures." : undefined
            }
          />
        }
        header={{
          kicker: "Admin",
          title: "Email failures",
          description:
            "System-originated sends that Graph rejected or were blocked by the mailbox-kind preflight.",
          fontFamily: "display",
        }}
        filtersSlot={filtersSlot}
      />
      <DetailDialog
        row={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </>
  );
}

function FailureDesktopRow({
  row,
  timePrefs,
  onSelect,
}: {
  row: FailureRow;
  timePrefs: TimePrefs;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-4 border-b border-border bg-card px-4 py-3 text-left text-sm transition hover:bg-accent/20"
      data-row-flash="new"
    >
      <div className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">
        <UserTimeClient value={row.queuedAt} prefs={timePrefs} mode="relative" />
        <div
          className="text-[10px] text-muted-foreground/70"
          title={row.queuedAt}
        >
          <UserTimeClient value={row.queuedAt} prefs={timePrefs} />
        </div>
      </div>
      <div className="w-40 shrink-0 text-xs">
        <div className="truncate text-foreground/90">
          {row.fromUserDisplayName ?? row.fromUserEmailSnapshot}
        </div>
        {row.fromUserDisplayName ? (
          <div className="truncate text-[10px] text-muted-foreground/70">
            {row.fromUserEmailSnapshot}
          </div>
        ) : null}
      </div>
      <div className="hidden w-48 shrink-0 truncate text-xs text-foreground/90 md:block">
        {row.toEmail}
      </div>
      <div className="hidden w-40 shrink-0 truncate font-mono text-xs text-muted-foreground lg:block">
        {row.feature}
      </div>
      <div className="w-32 shrink-0 text-xs">
        <StatusBadge status={row.status} />
      </div>
      <div className="hidden min-w-0 flex-1 text-xs text-muted-foreground lg:block">
        {row.errorCode ? (
          <span className="font-mono text-foreground/90">{row.errorCode}</span>
        ) : null}
        {row.errorMessage ? (
          <div className="mt-0.5 max-w-md truncate text-[11px] text-muted-foreground/90">
            {row.errorMessage}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function FailureMobileCard({
  row,
  timePrefs,
  onSelect,
}: {
  row: FailureRow;
  timePrefs: TimePrefs;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full flex-col gap-1.5 rounded-md border border-border bg-card p-3 text-left"
      data-row-flash="new"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <UserTimeClient value={row.queuedAt} prefs={timePrefs} />
        <StatusBadge status={row.status} />
      </div>
      <div className="truncate text-sm text-foreground">{row.toEmail}</div>
      <div className="truncate font-mono text-xs text-muted-foreground">
        {row.feature}
      </div>
      {row.errorMessage ? (
        <div className="truncate text-xs text-muted-foreground/90">
          {row.errorMessage}
        </div>
      ) : null}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label =
    status === "blocked_preflight"
      ? "blocked (preflight)"
      : status === "blocked_e2e"
        ? "blocked (E2E)"
        : status;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold",
        statusChipClass(status),
      )}
    >
      {label}
    </span>
  );
}

function statusChipClass(status: string): string {
  switch (status) {
    case "failed":
      return "bg-red-500/15 text-red-400 ring-1 ring-inset ring-red-500/30";
    case "blocked_preflight":
      return "bg-amber-500/15 text-amber-400 ring-1 ring-inset ring-amber-500/30";
    case "blocked_e2e":
      return "bg-muted/60 text-muted-foreground ring-1 ring-inset ring-border";
    case "sent":
      return "bg-emerald-500/15 text-emerald-400 ring-1 ring-inset ring-emerald-500/30";
    default:
      return "bg-muted/40 text-muted-foreground";
  }
}

function DetailDialog({
  row,
  onOpenChange,
}: {
  row: FailureRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = row !== null;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="mwg-mobile-sheet fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <Dialog.Title className="text-base font-semibold text-foreground">
            Email send detail
          </Dialog.Title>
          {row ? (
            <DetailBody row={row} onClose={() => onOpenChange(false)} />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DetailBody({
  row,
  onClose,
}: {
  row: FailureRow;
  onClose: () => void;
}) {
  return (
    <div className="mt-4 space-y-4 text-sm">
      <Field label="Status">
        <StatusBadge status={row.status} />
      </Field>
      <Field label="Subject">
        <span className="text-foreground/90">{row.subject}</span>
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="From">
          <div className="text-foreground/90">
            {row.fromUserDisplayName ?? row.fromUserEmailSnapshot}
          </div>
          <div className="text-[11px] text-muted-foreground/80">
            {row.fromUserEmailSnapshot}
          </div>
        </Field>
        <Field label="To">
          <span className="text-foreground/90">{row.toEmail}</span>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Feature">
          <span className="font-mono text-xs text-foreground/90">
            {row.feature}
          </span>
          {row.featureRecordId ? (
            <div className="font-mono text-[11px] text-muted-foreground/80">
              record: {row.featureRecordId}
            </div>
          ) : null}
        </Field>
        <Field label="Queued at">
          <span className="font-mono text-xs text-foreground/90">
            {row.queuedAt}
          </span>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Field label="HTTP status">
          <span className="font-mono text-xs text-foreground/90">
            {row.httpStatus ?? "—"}
          </span>
        </Field>
        <Field label="Duration">
          <span className="font-mono text-xs text-foreground/90">
            {row.durationMs == null ? "—" : `${row.durationMs} ms`}
          </span>
        </Field>
        <Field label="Attachments">
          <span className="font-mono text-xs text-foreground/90">
            {row.hasAttachments
              ? `${row.attachmentCount} (${formatBytes(row.totalSizeBytes)})`
              : "none"}
          </span>
        </Field>
      </div>
      <Field label="Graph message id">
        <span className="break-all font-mono text-xs text-foreground/90">
          {row.graphMessageId ?? "—"}
        </span>
      </Field>
      <Field label="Request id">
        <span className="break-all font-mono text-xs text-foreground/90">
          {row.requestId ?? "—"}
        </span>
      </Field>
      {row.retryOfId ? (
        <Field label="Retry of">
          <span className="break-all font-mono text-xs text-foreground/90">
            {row.retryOfId}
          </span>
        </Field>
      ) : null}
      <Field label="Error code">
        <span className="font-mono text-xs text-foreground/90">
          {row.errorCode ?? "—"}
        </span>
      </Field>
      <Field label="Error message">
        <pre className="whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11px] text-foreground/90">
          {row.errorMessage ?? "—"}
        </pre>
      </Field>
      {row.metadata ? (
        <Field label="Metadata">
          <pre className="overflow-x-auto rounded bg-black/30 p-2 font-mono text-[11px] text-foreground/90">
            {JSON.stringify(row.metadata, null, 2)}
          </pre>
        </Field>
      ) : null}

      <div className="mwg-mobile-sheet-actions mt-6 flex items-center justify-end gap-2 border-t border-border/60 pt-4">
        {row.status === "failed" ? (
          <DrawerRetryButton row={row} onDone={onClose} />
        ) : (
          <span className="mr-auto text-[11px] text-muted-foreground/80">
            Retry not available — preflight-blocked sends require a config
            fix on the sender mailbox.
          </span>
        )}
        <Dialog.Close asChild>
          <button
            type="button"
            className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-muted"
          >
            Close
          </button>
        </Dialog.Close>
      </div>
    </div>
  );
}

function DrawerRetryButton({
  row,
  onDone,
}: {
  row: FailureRow;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function trigger() {
    setErr(null);
    setOk(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/admin/email-failures/${row.id}/retry`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
          status?: string;
          newLogId?: string;
        };
        if (!res.ok) {
          setErr(json.message ?? json.error ?? `HTTP ${res.status}`);
          return;
        }
        setOk(`Retry queued — new send status: ${json.status ?? "unknown"}`);
        router.refresh();
        setTimeout(() => onDone(), 800);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Retry failed");
      }
    });
  }

  return (
    <>
      {err ? (
        <span className="mr-auto text-[11px] text-red-400" role="alert">
          {err}
        </span>
      ) : null}
      {ok ? (
        <span className="mr-auto text-[11px] text-emerald-400">{ok}</span>
      ) : null}
      <button
        type="button"
        onClick={trigger}
        disabled={pending}
        className="rounded-md border border-border bg-input/40 px-3 py-1.5 text-sm text-foreground/90 transition hover:bg-accent/40 disabled:opacity-50"
      >
        {pending ? "Retrying…" : "Retry send"}
      </button>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
