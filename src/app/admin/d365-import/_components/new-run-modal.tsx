"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-alert-dialog";
import { Plus } from "lucide-react";
import { useShowPicker } from "@/hooks/use-show-picker";
import { StandardCollapsibleSection } from "@/components/standard";
import {
  createRunAction,
  importAllRootsAction,
} from "@/app/admin/d365-import/actions";
import { D365_ROOT_TYPES, type D365RootType } from "@/lib/d365/types";
import { cn } from "@/lib/utils";

/**
 * "Start an import" modal for the root-aggregate D365 import.
 *
 * The unit of work is one root record type (lead / contact / account /
 * opportunity). Each root's child records (tasks, calls, appointments,
 * emails, notes) are imported automatically with it and are never
 * imported on their own.
 *
 * Primary path (default): import all four record types in dependency
 * order via {@link importAllRootsAction}, then land on the runs list
 * where the four new runs appear.
 *
 * Secondary path (inside a collapsible section): import a single record
 * type via {@link createRunAction}, then open that run.
 *
 * Shared scope fields — `modifiedSince` (default two years ago) and
 * "Active records only" — apply to whichever path the operator chooses.
 */

const ROOT_LABELS: Record<D365RootType, string> = {
  account: "Accounts",
  contact: "Contacts",
  lead: "Leads",
  opportunity: "Opportunities",
};

function defaultModifiedSince(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().slice(0, 10);
}

export function NewRunModal({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [singleType, setSingleType] = useState<D365RootType>("lead");
  const [modifiedSince, setModifiedSince] = useState(defaultModifiedSince());
  const [activeOnly, setActiveOnly] = useState(true);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const modifiedSincePicker = useShowPicker();

  function buildScopeFields(): FormData {
    const fd = new FormData();
    fd.set("modifiedSince", modifiedSince);
    if (activeOnly) fd.set("activeOnly", "on");
    return fd;
  }

  function importAll() {
    setError(null);
    startTransition(async () => {
      const fd = buildScopeFields();
      // importAllRootsAction parses createRunSchema (entityType required)
      // but ignores the value — it always seeds all four root runs in
      // dependency order. Send a placeholder root to satisfy the schema.
      fd.set("entityType", "lead");
      const res = await importAllRootsAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      // The runs list shows the four new runs in dependency order.
      router.push("/admin/d365-import");
      router.refresh();
    });
  }

  function importSingle() {
    setError(null);
    startTransition(async () => {
      const fd = buildScopeFields();
      fd.set("entityType", singleType);
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
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Start an import
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
          <Dialog.Title className="text-base font-semibold text-foreground">
            Start an import
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Choose a record type to import from Dynamics 365. Each record&apos;s
            tasks, calls, appointments, emails, and notes come with it
            automatically — child records are never imported on their own. The
            first batch fetches when you start.
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            <section className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
              <h3 className="text-sm font-medium text-foreground">
                Import all record types
              </h3>
              <p className="text-xs text-muted-foreground">
                Imports accounts, contacts, leads, and opportunities — with their
                related records — in dependency order so links resolve as each
                type lands. Creates four runs you review and approve separately.
              </p>
              <button
                type="button"
                onClick={importAll}
                disabled={pending}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "Starting…" : "Import all record types"}
              </button>
            </section>

            <StandardCollapsibleSection
              sectionKey="single-root"
              label="Import a single record type"
              defaultExpanded={false}
              storagePrefix="mwgcrm.d365-import.start."
              domIdPrefix="d365-import-start-"
            >
              <div className="space-y-3 pt-1">
                <fieldset>
                  <legend className="sr-only">Record type</legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {D365_ROOT_TYPES.map((t) => (
                      <label
                        key={t}
                        className={cn(
                          "flex cursor-pointer items-center justify-center rounded border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground",
                          singleType === t &&
                            "border-foreground/40 bg-background font-medium",
                        )}
                      >
                        <input
                          type="radio"
                          name="singleRootType"
                          value={t}
                          checked={singleType === t}
                          onChange={() => setSingleType(t)}
                          className="sr-only"
                        />
                        {ROOT_LABELS[t]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button
                  type="button"
                  onClick={importSingle}
                  disabled={pending}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground whitespace-nowrap transition hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? "Starting…" : `Import ${ROOT_LABELS[singleType].toLowerCase()}`}
                </button>
              </div>
            </StandardCollapsibleSection>

            <div className="space-y-3 border-t border-border pt-4">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Modified since
                <input
                  type="date"
                  value={modifiedSince}
                  onChange={(ev) => setModifiedSince(ev.target.value)}
                  onClick={modifiedSincePicker}
                  className="rounded-md border border-border bg-input px-3 py-1.5 text-xs text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
                />
                <span className="text-[11px] text-muted-foreground/70">
                  Only import records changed in Dynamics 365 on or after this
                  date. Defaults to two years ago.
                </span>
              </label>

              <label className="flex items-start gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={activeOnly}
                  onChange={(ev) => setActiveOnly(ev.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border border-border bg-background text-primary focus:ring-ring/40"
                />
                <span>
                  Active records only
                  <span className="block text-[11px] text-muted-foreground">
                    Skip inactive and closed records. Clear this to import every
                    state.
                  </span>
                </span>
              </label>
            </div>

            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex justify-end pt-1">
              <Dialog.Cancel asChild>
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
              </Dialog.Cancel>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
