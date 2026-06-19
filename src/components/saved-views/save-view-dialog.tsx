"use client";

import { useState } from "react";
import { StandardDialog } from "@/components/standard";

/**
 * Shared "Save current view" dialog used by every entity view-toolbar
 * (leads, accounts, contacts, opportunities).
 *
 * Built on the canonical `StandardDialog` (Radix-backed) so focus trap,
 * Escape-to-close, focus restoration, body scroll lock, and portal/aria
 * wiring come for free. The only variable surface is:
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
    <StandardDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      contentClassName="sm:max-w-md"
      title="Save current view"
      description="Captures your current filters and columns so you can come back to them with one click."
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="save-view-form"
            disabled={submitting || !name.trim()}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Saving…" : "Save view"}
          </button>
        </>
      }
    >
      <form id="save-view-form" onSubmit={onSubmit} className="space-y-3">
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Name
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "save-view-error" : undefined}
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
          <p
            id="save-view-error"
            role="alert"
            className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-xs text-[var(--status-lost-fg)]"
          >
            {error}
          </p>
        ) : null}
      </form>
    </StandardDialog>
  );
}
