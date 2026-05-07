"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { recomputeAllScoresAction } from "../actions";

/**
 * Phase 5B — runs the full re-score loop synchronously. The action caps
 * at 10,000 leads and refuses on overflow with a friendly message.
 */
export function RecomputeButton() {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function go() {
    setConfirming(false);
    startTransition(async () => {
      const startedAt = Date.now();
      const res = await recomputeAllScoresAction();
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (!res.ok) {
        toast.error(res.error);
      } else {
        toast.success(`Recomputed ${res.data.processed} leads in ${elapsed}s`);
      }
    });
  }

  if (confirming) {
    return (
      <div className="rounded-md border border-glass-border bg-primary/5 p-3">
        <p className="text-sm">
          This will re-score every active lead with the current rules and
          thresholds. Typically 5–30 seconds for a few thousand leads.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={go}
            disabled={pending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {pending ? "Recomputing…" : "Yes, recompute now"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/40"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      disabled={pending}
      className="rounded-md border border-glass-border px-3 py-1.5 text-sm hover:bg-accent/30 disabled:opacity-50"
    >
      Recompute all leads now
    </button>
  );
}
