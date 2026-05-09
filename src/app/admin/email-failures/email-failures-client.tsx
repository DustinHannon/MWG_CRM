"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UserTimeClient } from "@/components/ui/user-time-client";
import type { TimePrefs } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import type { FailureRow } from "./page";

interface Props {
  rows: FailureRow[];
  timePrefs: TimePrefs;
}

/**
 * Phase 15 — table + detail drawer for `/admin/email-failures`.
 *
 * Click a row → opens the detail dialog with the full row payload
 * (graphMessageId, httpStatus, durationMs, requestId, metadata JSON,
 * full errorMessage). Retry is only offered for `status='failed'`;
 * `blocked_preflight` rows are a config issue (sender's mailbox is not
 * Exchange Online), not a transient failure, so retrying solves nothing.
 *
 * The retry endpoint sends a placeholder body — see
 * `[id]/retry/route.ts` for the rationale.
 */
export function EmailFailuresClient({ rows, timePrefs }: Props) {
  const [selected, setSelected] = useState<FailureRow | null>(null);

  return (
    <>
      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-muted/40 backdrop-blur-xl">
        <table className="data-table min-w-full divide-y divide-border/60 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Queued</th>
              <th className="px-5 py-3 font-medium">From</th>
              <th className="px-5 py-3 font-medium">To</th>
              <th className="px-5 py-3 font-medium">Feature</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Error</th>
              <th className="px-5 py-3 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-10 text-center text-muted-foreground"
                >
                  No email failures match.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer align-top transition hover:bg-muted/60"
                onClick={() => setSelected(r)}
              >
                <td className="px-5 py-3 text-xs text-muted-foreground tabular-nums">
                  <UserTimeClient
                    value={r.queuedAt}
                    prefs={timePrefs}
                    mode="relative"
                  />
                  <div
                    className="text-[10px] text-muted-foreground/70"
                    title={r.queuedAt}
                  >
                    <UserTimeClient value={r.queuedAt} prefs={timePrefs} />
                  </div>
                </td>
                <td className="px-5 py-3 text-xs">
                  <div className="text-foreground/90">
                    {r.fromUserDisplayName ?? r.fromUserEmailSnapshot}
                  </div>
                  {r.fromUserDisplayName ? (
                    <div className="text-[10px] text-muted-foreground/70">
                      {r.fromUserEmailSnapshot}
                    </div>
                  ) : null}
                </td>
                <td className="px-5 py-3 text-xs text-foreground/90">
                  {r.toEmail}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                  {r.feature}
                </td>
                <td className="px-5 py-3 text-xs">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-5 py-3 text-xs text-muted-foreground">
                  {r.errorCode ? (
                    <span className="font-mono text-foreground/90">
                      {r.errorCode}
                    </span>
                  ) : null}
                  {r.errorMessage ? (
                    <div className="mt-0.5 max-w-md truncate text-[11px] text-muted-foreground/90">
                      {r.errorMessage}
                    </div>
                  ) : null}
                </td>
                <td className="px-5 py-3 text-right text-xs">
                  {r.status === "failed" ? (
                    <RetryInlineButton
                      logId={r.id}
                      onComplete={() => setSelected(null)}
                    />
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DetailDialog
        row={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </>
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

function RetryInlineButton({
  logId,
  onComplete,
}: {
  logId: string;
  onComplete?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function trigger(e: React.MouseEvent) {
    e.stopPropagation();
    setErr(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/admin/email-failures/${logId}/retry`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        });
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (!res.ok) {
          setErr(json.message ?? json.error ?? `HTTP ${res.status}`);
          return;
        }
        onComplete?.();
        router.refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Retry failed");
      }
    });
  }

  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={trigger}
        disabled={pending}
        className="rounded-md border border-border bg-input/40 px-2 py-1 text-[11px] uppercase tracking-wide text-foreground/80 transition hover:bg-accent/40 disabled:opacity-50"
      >
        {pending ? "Retrying…" : "Retry"}
      </button>
      {err ? (
        <span className="text-[10px] text-red-400" role="alert">
          {err}
        </span>
      ) : null}
    </div>
  );
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
          {row ? <DetailBody row={row} onClose={() => onOpenChange(false)} /> : null}
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
        <span className="font-mono text-xs text-foreground/90 break-all">
          {row.graphMessageId ?? "—"}
        </span>
      </Field>
      <Field label="Request id">
        <span className="font-mono text-xs text-foreground/90 break-all">
          {row.requestId ?? "—"}
        </span>
      </Field>
      {row.retryOfId ? (
        <Field label="Retry of">
          <span className="font-mono text-xs text-foreground/90 break-all">
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
        // Auto-close after a beat so the admin sees the confirmation.
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
