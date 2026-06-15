"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StandardConfirmDialog } from "@/components/standard";
import {
  abortRunAction,
  markRunCompleteAction,
  reconcileRunFksAction,
} from "@/app/admin/d365-import/actions";

/**
 * bottom-of-page run controls.
 *
 * Active run: Abort run (admin confirm) + Mark complete (only when
 * canMarkComplete is true, i.e. no pending/reviewing/approved batches
 * outstanding). Marking complete already runs the cross-root FK reconcile
 * sweep automatically.
 *
 * Completed run: a single "Re-resolve links" control that re-runs the
 * cross-root FK reconcile sweep on demand (idempotent — only fills
 * still-null FKs once a parent root from a sibling run has since landed).
 *
 * Aborted run: no controls.
 */
export function RunControls({
  runId,
  status,
  canMarkComplete,
}: {
  runId: string;
  status: string;
  canMarkComplete: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (status === "aborted") return null;
  if (status === "completed") {
    return <ReconcileLinksControl runId={runId} />;
  }

  async function onAbortConfirm() {
    setError(null);
    const fd = new FormData();
    fd.set("runId", runId);
    const res = await abortRunAction(fd);
    if (!res.ok) {
      setError(res.error);
      // Throw so StandardConfirmDialog keeps itself open for retry.
      throw new Error(res.error);
    }
    router.refresh();
  }

  function onComplete() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("runId", runId);
      const res = await markRunCompleteAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <h3 className="text-sm font-medium text-foreground">Run controls</h3>
      <div className="ml-auto flex flex-wrap gap-2">
        <StandardConfirmDialog
          trigger={
            <button
              type="button"
              disabled={pending}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
            >
              {pending ? "Working…" : "Abort run"}
            </button>
          }
          title="Abort this import run?"
          body="Records already committed stay in the CRM. Nothing further will be imported for this run."
          confirmLabel="Abort run"
          tone="destructive"
          onConfirm={onAbortConfirm}
        />
        <button
          type="button"
          onClick={onComplete}
          disabled={!canMarkComplete || pending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
        >
          Mark complete
        </button>
      </div>
      {error ? (
        <p className="basis-full text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

/**
 * On-demand cross-root FK reconcile for a completed run. Mark-complete
 * already runs this sweep once; this lets an admin re-run it after a
 * sibling run's parent root lands so a previously-unresolvable link
 * (e.g. an opportunity→account edge) fills in. Idempotent.
 */
function ReconcileLinksControl({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onReconcile() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("runId", runId);
      const res = await reconcileRunFksAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(
        `Re-resolved ${res.data.resolved} record${
          res.data.resolved === 1 ? "" : "s"
        }; ${res.data.stillUnresolved} link${
          res.data.stillUnresolved === 1 ? "" : "s"
        } still unresolved.`,
      );
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <h3 className="text-sm font-medium text-foreground">Run controls</h3>
      <p className="text-xs text-muted-foreground">
        Re-resolve cross-record links left unresolved at import time, once a
        related record from another run has landed.
      </p>
      <button
        type="button"
        onClick={onReconcile}
        disabled={pending}
        className="ml-auto rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
      >
        {pending ? "Working…" : "Re-resolve links"}
      </button>
      {error ? (
        <p className="basis-full text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
