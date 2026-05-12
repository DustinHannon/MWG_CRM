"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FilterDslBuilder } from "@/components/marketing/filter-dsl-builder";
import { LivePreviewPanel } from "@/components/marketing/live-preview-panel";
import type { FilterDsl } from "@/lib/security/filter-dsl";
import type { MarketingListSourceEntity } from "@/db/schema/marketing-lists";
import {
  createListAction,
  updateListAction,
} from "@/app/(app)/marketing/lists/actions";

/**
 * Client form for creating or editing a marketing list.
 *
 * Composes the filter-DSL builder + the right-rail live preview.
 * Submits to `createListAction` (new) or `updateListAction` (edit).
 */
interface Props {
  mode: "create" | "edit";
  initial?: {
    id: string;
    name: string;
    description: string | null;
    filterDsl: FilterDsl;
    /** OCC version captured at load time. */
    version: number;
    sourceEntity?: MarketingListSourceEntity | null;
  };
}

export function ListForm({ mode, initial }: Props) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(
    initial?.description ?? "",
  );
  const [dsl, setDsl] = useState<FilterDsl | null>(
    initial?.filterDsl ?? null,
  );
  // source entity for dynamic lists. Only 'leads' is wired
  // today; the picker shows the others greyed out for forward
  // compatibility.
  const [sourceEntity, setSourceEntity] = useState<MarketingListSourceEntity>(
    initial?.sourceEntity ?? "leads",
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dsl) {
      toast.error("Finish filling in the filter rules before saving.");
      return;
    }
    if (errors.length > 0) {
      toast.error("Finish filling in the filter rules before saving.");
      return;
    }
    startTransition(async () => {
      if (mode === "create") {
        const result = await createListAction({
          name,
          description: description.trim() || undefined,
          filterDsl: dsl,
          sourceEntity,
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success("List created.");
        router.push(`/marketing/lists/${result.data.id}`);
      } else {
        if (!initial) return;
        const result = await updateListAction({
          id: initial.id,
          name,
          description: description.trim() || undefined,
          filterDsl: dsl,
          // pass the version we loaded so the action
          // refuses to write if another user beat us to it.
          expectedVersion: initial.version,
        });
        if (!result.ok) {
          // 409 Conflict ⇒ another user updated the list since load.
          // Surfacing as a directive toast (reload). Future enhancement:
          // render the side-by-side OCCConflictDialog.
          if (result.code === "CONFLICT") {
            toast.error(
              "This list was updated by someone else. Reload to see the latest version.",
            );
            return;
          }
          toast.error(result.error);
          return;
        }
        toast.success("List updated.");
        router.push(`/marketing/lists/${initial.id}`);
        router.refresh();
      }
    });
  }

  const submitDisabled =
    pending || !dsl || errors.length > 0 || name.trim().length === 0;

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]"
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="list-name"
            className="text-xs uppercase tracking-[0.05em] text-muted-foreground"
          >
            Name
          </label>
          <input
            id="list-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
            placeholder="e.g., Hot leads — Texas"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="list-description"
            className="text-xs uppercase tracking-[0.05em] text-muted-foreground"
          >
            Description
          </label>
          <textarea
            id="list-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={2}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
            placeholder="Why this segment exists (optional)"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="list-source-entity"
            className="text-xs uppercase tracking-[0.05em] text-muted-foreground"
          >
            Source entity
          </label>
          <select
            id="list-source-entity"
            value={sourceEntity}
            onChange={(e) =>
              setSourceEntity(e.target.value as MarketingListSourceEntity)
            }
            disabled={mode === "edit"}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
            title="Available in a future phase"
          >
            <option value="leads">Leads</option>
            <option value="contacts" disabled>
              Contacts (available in a future phase)
            </option>
            <option value="accounts" disabled>
              Accounts (available in a future phase)
            </option>
            <option value="opportunities" disabled>
              Opportunities (available in a future phase)
            </option>
            <option value="mixed" disabled>
              Mixed (available in a future phase)
            </option>
          </select>
          <p className="text-xs text-muted-foreground">
            Filter rules evaluate against this entity. Only leads are wired today.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            Filter rules
          </h2>
          <FilterDslBuilder
            initial={initial?.filterDsl}
            onChange={(next) => {
              setDsl(next);
              setErrors([]);
            }}
            onValidationError={(es) => setErrors(es)}
          />
          {errors.length > 0 ? (
            <div className="rounded-md border border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
              <p className="font-medium text-foreground/90">
                Before saving — finish the filter rules:
              </p>
              <ul className="mt-1 list-disc pl-4">
                {errors.slice(0, 3).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={submitDisabled}
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-50"
          >
            {pending
              ? mode === "create"
                ? "Creating…"
                : "Saving…"
              : mode === "create"
                ? "Create list"
                : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            disabled={pending}
            className="inline-flex items-center rounded-md border border-border bg-muted/40 px-4 py-2 text-sm text-foreground/90 transition hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>

      <LivePreviewPanel dsl={dsl} />
    </form>
  );
}
