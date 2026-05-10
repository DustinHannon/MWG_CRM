"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-alert-dialog";
import { Plus } from "lucide-react";
import { D365_ENTITY_TYPES, type D365EntityType } from "@/lib/d365/types";
import { createRunAction } from "@/app/admin/d365-import/actions";
import { cn } from "@/lib/utils";

/**
 * Phase 23 — "+ New import run" advanced modal.
 *
 * Fields:
 *   - entity radio (9 options)
 *   - modifiedSince date (default 2 years ago)
 *   - activeOnly toggle
 *   - includeChildren toggle (only for lead/contact/account/opportunity)
 *
 * Confirm → calls `createRunAction`, redirects to /admin/d365-import/<id>.
 */

const EXPANDABLE = new Set(["lead", "contact", "account", "opportunity"]);

function defaultModifiedSince(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

export function NewRunModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [entity, setEntity] = useState<D365EntityType>("lead");
  const [modifiedSince, setModifiedSince] = useState(defaultModifiedSince());
  const [activeOnly, setActiveOnly] = useState(true);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("entityType", entity);
      fd.set("modifiedSince", modifiedSince);
      if (activeOnly) fd.set("activeOnly", "on");
      if (includeChildren && EXPANDABLE.has(entity))
        fd.set("includeChildren", "on");
      const res = await createRunAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.push(`/admin/d365-import/${res.data.runId}`);
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
        >
          <Plus className="h-3.5 w-3.5" />
          New import run
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
          <Dialog.Title className="text-base font-semibold text-foreground">
            New D365 import run
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Advanced configuration for a single-entity import. The first
            batch of 100 fetches when you click Create.
          </Dialog.Description>

          <form className="mt-4 space-y-4" onSubmit={onSubmit}>
            <fieldset>
              <legend className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Entity
              </legend>
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {D365_ENTITY_TYPES.map((e) => (
                  <label
                    key={e}
                    className={cn(
                      "flex cursor-pointer items-center justify-center rounded border border-border bg-muted/40 px-2 py-1 text-xs",
                      entity === e &&
                        "border-foreground/40 bg-background font-medium",
                    )}
                  >
                    <input
                      type="radio"
                      name="entityType"
                      value={e}
                      checked={entity === e}
                      onChange={() => setEntity(e as D365EntityType)}
                      className="sr-only"
                    />
                    {e}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Modified since
              <input
                type="date"
                value={modifiedSince}
                onChange={(ev) => setModifiedSince(ev.target.value)}
                className="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(ev) => setActiveOnly(ev.target.checked)}
              />
              Active records only (statecode=0)
            </label>

            <label
              className={cn(
                "flex items-center gap-2 text-xs",
                EXPANDABLE.has(entity)
                  ? "text-foreground"
                  : "text-muted-foreground/50",
              )}
            >
              <input
                type="checkbox"
                disabled={!EXPANDABLE.has(entity)}
                checked={includeChildren && EXPANDABLE.has(entity)}
                onChange={(ev) => setIncludeChildren(ev.target.checked)}
              />
              Include children (notes + activities) — only for
              lead/contact/account/opportunity
            </label>

            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <Dialog.Cancel asChild>
                <button
                  type="button"
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
                >
                  Cancel
                </button>
              </Dialog.Cancel>
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
              >
                {pending ? "Creating…" : "Create run"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
