"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { updateOpportunityAction } from "../../../actions";
import type { ActionResult } from "@/lib/server-action";

/** Opportunity edit form. */
export function OpportunityEditForm({
  opportunity,
}: {
  opportunity: {
    id: string;
    version: number;
    name: string;
    stage: string;
    amount: string | null;
    expectedCloseDate: string | null;
    description: string | null;
  };
}) {
  const router = useRouter();
  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => updateOpportunityAction(fd), initial);

  useEffect(() => {
    if (state === initial) return;
    if (state.ok) {
      toast.success("Opportunity updated");
      router.push(`/opportunities/${opportunity.id}`);
    } else {
      toast.error(state.error, { duration: Infinity, dismissible: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className="mt-6 grid gap-4 max-w-2xl">
      <input type="hidden" name="id" value={opportunity.id} />
      <input type="hidden" name="version" value={opportunity.version} />

      <Field label="Name *">
        <input
          name="name"
          defaultValue={opportunity.name}
          required
          maxLength={200}
          className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Stage">
          <select
            name="stage"
            defaultValue={opportunity.stage}
            className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
          >
            <option value="prospecting">Prospecting</option>
            <option value="qualification">Qualification</option>
            <option value="proposal">Proposal</option>
            <option value="negotiation">Negotiation</option>
            <option value="closed_won">Closed — won</option>
            <option value="closed_lost">Closed — lost</option>
          </select>
        </Field>
        <Field label="Amount (USD)">
          <input
            name="amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            defaultValue={opportunity.amount ?? ""}
            className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
          />
        </Field>
      </div>

      <Field label="Expected close date">
        <input
          name="expectedCloseDate"
          type="date"
          defaultValue={opportunity.expectedCloseDate ?? ""}
          className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
        />
      </Field>

      <Field label="Description">
        <textarea
          name="description"
          defaultValue={opportunity.description ?? ""}
          maxLength={4000}
          rows={5}
          className="rounded-md border border-border bg-input/60 px-3 py-2 text-sm"
        />
      </Field>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/opportunities/${opportunity.id}`)}
          disabled={pending}
          className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
