"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  abortRunAction,
  markRunCompleteAction,
} from "@/app/admin/d365-import/actions";

/**
 * bottom-of-page run controls. Two buttons:
 * Abort run (admin confirm).
 * Mark complete (only when canMarkComplete is true, i.e. no
 * pending/reviewing/approved batches outstanding).
 *
 * Wraps the corresponding server actions. Hidden entirely when the
 * run is already terminal (completed / aborted).
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

  if (status === "completed" || status === "aborted") return null;

  function onAbort() {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Abort this run? Records already committed will remain; nothing else will be imported.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("runId", runId);
      const res = await abortRunAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
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
        <button
          type="button"
          onClick={onAbort}
          disabled={pending}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          {pending ? "Working…" : "Abort run"}
        </button>
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
