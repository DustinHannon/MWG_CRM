"use client";

import { useState } from "react";

/**
 * Shared "Save current view" dialog used by every entity view-toolbar
 * (leads, accounts, contacts, opportunities).
 *
 * The dialog is hand-rolled (not Radix) — markup, classes, overlay, and
 * a11y are preserved verbatim from the original per-entity copies. The
 * only variable surface is:
 *   - `namePlaceholder` — entity-specific example hint text
 *   - `buildPayloadJson()` — caller builds the opaque JSON string that
 *     maps URL params → filter/sort/columns shape. The string is
 *     forwarded to `onSave` unchanged; no field-mapping inside here.
 *   - `onSave()` — calls the per-entity `createXViewAction`
 *   - `onSaved()` — post-save close + navigation
 *
 * Mount/unmount is controlled by the parent (wrap in `{saveOpen ? <SaveViewDialog .../> : null}`)
 * so each open starts with fresh state — matching the original per-entity behavior exactly.
 */
export interface SaveViewDialogProps {
  /** Called to close the dialog (Cancel or overlay click). */
  onClose: () => void;
  /**
   * Builds the opaque JSON payload string. Called at submit time.
   * Receives `name` (trimmed) and `pin` so the caller can embed them
   * in the payload shape without this component needing to know the
   * entity-specific payload schema.
   */
  buildPayloadJson: (args: { name: string; pin: boolean }) => string;
  /**
   * Calls the per-entity `createXViewAction` with a FormData
   * containing `payload`. Returns `{ok,error?,data?}`.
   */
  onSave: (args: {
    payloadJson: string;
  }) => Promise<{ ok: boolean; error?: string; data?: { id?: string } }>;
  /**
   * Called after a successful save. Receives the new saved-view id
   * prefixed with `"saved:"` so the caller can navigate to the new view.
   */
  onSaved: (newId: string) => void;
  /** Entity-specific placeholder for the name input. */
  namePlaceholder: string;
}

export function SaveViewDialog({
  onClose,
  buildPayloadJson,
  onSave,
  onSaved,
  namePlaceholder,
}: SaveViewDialogProps) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);

    const payloadJson = buildPayloadJson({ name: name.trim(), pin });
    const res = await onSave({ payloadJson });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? "Save failed.");
      return;
    }
    if (res.data?.id) onSaved(`saved:${res.data.id}`);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-border bg-[var(--popover)] text-[var(--popover-foreground)] p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold">Save current view</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Captures your current filters and columns so you can come back to
          them with one click.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block text-xs uppercase tracking-wide text-muted-foreground">
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              placeholder={namePlaceholder}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pin}
              onChange={(e) => setPin(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring"
            />
            <span>Pin to top of list</span>
          </label>
          {error ? (
            <p className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-xs text-[var(--status-lost-fg)]">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Saving…" : "Save view"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
