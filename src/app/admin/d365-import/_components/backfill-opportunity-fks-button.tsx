"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StandardConfirmDialog } from "@/components/standard";
import { backfillOpportunityFksAction } from "@/app/admin/d365-import/actions";

interface BackfillResult {
  scanned: number;
  resolved: number;
  stillUnresolved: number;
  noSourceProvenance: number;
}

/**
 * One-shot opportunity FK backfill control. Re-resolves NULL parent
 * FKs on already-committed D365 opportunities from their retained
 * staged raw payload. Idempotent — safe to re-run after a later
 * parent import. Surfaces the scan/resolve counts inline.
 */
export function BackfillOpportunityFksButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BackfillResult | null>(null);

  async function onConfirm() {
    setError(null);
    setResult(null);
    await new Promise<void>((resolve) => {
      startTransition(async () => {
        const res = await backfillOpportunityFksAction();
        if (!res.ok) {
          setError(res.error);
        } else {
          setResult(res.data);
          router.refresh();
        }
        resolve();
      });
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            Backfill opportunity links
          </h3>
          <p className="text-xs text-muted-foreground">
            Re-resolve missing account, contact, and lead links on
            imported opportunities from their original D365 payload.
            Safe to run more than once.
          </p>
        </div>
        <StandardConfirmDialog
          trigger={
            <button
              type="button"
              disabled={pending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? "Running…" : "Run backfill"}
            </button>
          }
          title="Run the opportunity link backfill?"
          body="Scans imported opportunities with missing parent links and resolves them from the retained D365 payload. Only fills links that are currently empty."
          confirmLabel="Run backfill"
          onConfirm={onConfirm}
        />
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
      {result ? (
        <p className="text-xs text-muted-foreground">
          Scanned {result.scanned} · resolved {result.resolved} ·
          still unresolved {result.stillUnresolved} · no D365 source{" "}
          {result.noSourceProvenance}
        </p>
      ) : null}
    </div>
  );
}
