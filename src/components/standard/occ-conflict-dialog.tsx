"use client";

import { useState } from "react";

/**
 * Phase 25 §7.1 — Side-by-side OCC conflict resolution dialog.
 *
 * Surfaced when a server action returns CONCURRENCY_CONFLICT (or
 * any ConflictError with `code === 'CONCURRENCY_CONFLICT'`). Renders
 * the user's draft alongside the server's current state, with the
 * differing fields highlighted. The modal is READ-ONLY. The only
 * resolution paths are:
 *
 *   - Refresh:   discard the local draft + re-render with server state.
 *                Caller wires this to a router.refresh() or full reload.
 *   - Overwrite: force-apply the local draft with the server's bumped
 *                version. Caller wires this to re-call the same
 *                server action with the server's version.
 *
 * Auto-merge is intentionally NOT offered (per Phase 25 §0 #10).
 * "View their changes" is read-only context, never auto-applied.
 *
 * The component is presentation-only — fetching the server state +
 * computing the diff is the caller's responsibility (the form that
 * caught the conflict already has the user's draft; it can hit the
 * relevant entity endpoint to load the current state).
 */
export interface OccConflictField {
  label: string;
  /** User's locally-edited value (what they tried to save). */
  draftValue: string | number | boolean | null;
  /** Server's current value (what someone else saved first). */
  serverValue: string | number | boolean | null;
}

export interface OccConflictDialogProps {
  /** When true, the dialog is rendered. */
  open: boolean;
  /** Close-without-resolve handler (e.g. user dismisses). Equivalent
   *  to Cancel — leaves the form in its dirty state so the user can
   *  copy values if they want. */
  onDismiss: () => void;
  /** Discard local edits + reload from server. */
  onRefresh: () => void;
  /** Force-apply local edits with the server's bumped version. */
  onOverwrite: () => void;
  /** Pre-computed field-by-field diff. Show only fields that differ
   *  (the caller filters before passing). */
  fields: OccConflictField[];
  /** Optional entity-friendly label e.g. "lead" or "campaign". */
  entityLabel?: string;
  /** True while either resolution is in flight; disables the buttons. */
  pending?: boolean;
}

export function OccConflictDialog({
  open,
  onDismiss,
  onRefresh,
  onOverwrite,
  fields,
  entityLabel = "record",
  pending,
}: OccConflictDialogProps) {
  // Local confirm-state for the Overwrite button — two-click safety
  // since Overwrite throws away whoever-saved-first's work.
  const [overwriteArmed, setOverwriteArmed] = useState(false);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Concurrent edit conflict for this ${entityLabel}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div
        className="w-full max-w-3xl rounded-lg border border-border bg-[var(--popover)] p-5 text-[var(--popover-foreground)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">
              Someone else updated this {entityLabel}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Your changes weren&apos;t saved because another writer
              updated this {entityLabel} first. Compare side-by-side, then
              choose how to resolve.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            disabled={pending}
            aria-label="Dismiss conflict dialog"
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {fields.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-border bg-muted/20 p-4 text-xs text-muted-foreground">
            The server&apos;s state matches your draft on every field —
            only the version number drifted. Click <strong>Refresh</strong>
            to sync and try again.
          </p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-md border border-border">
            <table className="w-full divide-y divide-border/60 text-sm">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Field</th>
                  <th className="px-3 py-2 text-left">Your edit</th>
                  <th className="px-3 py-2 text-left">Server&apos;s value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {fields.map((f) => (
                  <tr key={f.label} className="align-top">
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {f.label}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <DiffValue value={f.draftValue} highlight="local" />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <DiffValue value={f.serverValue} highlight="server" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={onDismiss}
            disabled={pending}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={pending}
            className="rounded-md border border-border bg-muted/40 px-4 py-1.5 text-sm hover:bg-muted"
            title="Discard your edits and reload the latest server state."
          >
            Refresh (use server&apos;s value)
          </button>
          {overwriteArmed ? (
            <button
              type="button"
              onClick={onOverwrite}
              disabled={pending}
              className="rounded-md bg-destructive px-4 py-1.5 text-sm font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Overwriting…" : "Confirm overwrite"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setOverwriteArmed(true)}
              disabled={pending}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-1.5 text-sm font-medium text-destructive transition hover:bg-destructive/20"
              title="Replace the server's value with yours. The other writer's changes will be lost."
            >
              Overwrite (use my edit)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffValue({
  value,
  highlight,
}: {
  value: string | number | boolean | null;
  highlight: "local" | "server";
}) {
  const tone =
    highlight === "local"
      ? "bg-primary/5 text-primary"
      : "bg-muted/30 text-foreground";
  const display =
    value === null
      ? "—"
      : typeof value === "boolean"
        ? value
          ? "yes"
          : "no"
        : String(value);
  return (
    <span className={`inline-block max-w-full break-words rounded px-2 py-0.5 ${tone}`}>
      {display}
    </span>
  );
}
