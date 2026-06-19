"use client";

import { toast } from "sonner";
import { StandardConfirmDialog } from "@/components/standard";
import { recomputeAllScoresAction } from "../actions";

/**
 * runs the full re-score loop synchronously. The action caps
 * at 10,000 leads and refuses on overflow with a friendly message.
 */
export function RecomputeButton() {
  async function go() {
    const startedAt = Date.now();
    const res = await recomputeAllScoresAction();
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (!res.ok) {
      toast.error(res.error);
      // Reject so the confirm dialog stays open for retry.
      throw new Error(res.error);
    }
    toast.success(`Recomputed ${res.data.processed} leads in ${elapsed}s`);
  }

  return (
    <StandardConfirmDialog
      title="Recompute all lead scores?"
      body="This will re-score every active lead with the current rules and thresholds. Typically 5–30 seconds for a few thousand leads."
      confirmLabel="Recompute now"
      onConfirm={go}
      trigger={
        <button
          type="button"
          className="rounded-md border border-glass-border px-3 py-1.5 text-sm hover:bg-accent/30 disabled:opacity-50"
        >
          Recompute all leads now
        </button>
      }
    />
  );
}
