"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StandardConfirmDialog } from "@/components/standard";
import { resetStuckBatchAction } from "@/app/admin/d365-import/actions";

/**
 * Reset-stuck-commit control, rendered only for a batch whose status
 * is `committing`. A batch lands there when commit-batch's transient
 * lock state was never rolled back — i.e. the function was hard-killed
 * (deploy recycle / OOM / wall-clock) mid-commit. Use only after
 * confirming the commit is not still running; the server action's
 * atomic `WHERE status = 'committing'` guard rejects the reset if a
 * live commit finishes first.
 */
export function ResetStuckBatchButton({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setError(null);
    const fd = new FormData();
    fd.set("batchId", batchId);
    const res = await resetStuckBatchAction(fd);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <StandardConfirmDialog
        trigger={
          <button
            type="button"
            className="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground transition hover:bg-muted"
          >
            Reset stuck commit
          </button>
        }
        title="Reset this batch to reviewing?"
        body="Use only if the commit was interrupted by a deploy or crash and is not still running. The batch returns to reviewing so it can be recommitted."
        confirmLabel="Reset to reviewing"
        tone="destructive"
        onConfirm={onConfirm}
      />
      {error ? (
        <span className="text-[11px] text-destructive">{error}</span>
      ) : null}
    </span>
  );
}
