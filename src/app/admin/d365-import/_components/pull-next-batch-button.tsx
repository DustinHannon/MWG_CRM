"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DownloadCloud } from "lucide-react";
import { pullNextBatchAction } from "@/app/admin/d365-import/actions";

/**
 * Phase 23 — pull-next-batch button on the run detail page.
 *
 * Disabled by the parent server component when:
 *   - run.status is aborted / completed / paused_for_review
 *   - latest batch is still pending / fetched / reviewing / approved
 *
 * On success the page revalidates from the action's revalidatePath
 * call; we additionally call `router.refresh()` so the latest batch
 * row appears immediately even when an in-flight Realtime broadcast
 * race delays it.
 */
export function PullNextBatchButton({
  runId,
  disabled,
}: {
  runId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("runId", runId);
      const res = await pullNextBatchAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      if (res.data.batchId) {
        router.push(`/admin/d365-import/${runId}/${res.data.batchId}`);
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
      >
        <DownloadCloud className="h-3.5 w-3.5" strokeWidth={1.5} />
        {pending ? "Pulling…" : "Pull next 100"}
      </button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
