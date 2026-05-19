"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { updateOpportunityAction } from "../../../actions";
import type { ActionResult } from "@/lib/server-action";
import {
  StandardFormField,
  StandardFormTextarea,
  StandardFormSelect,
  StandardFormSection,
  StandardFormRow,
  useEditFormResult,
} from "@/components/standard";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";

/**
 * Opportunity edit form. OCC via hidden `version`.
 *
 * Visual note: input backgrounds are now `bg-muted/40` (shared
 * CONTROL_CLASS in standard-form) rather than the previous local
 * `bg-input/60`. Intentional unification — one token per CLAUDE.md §8.
 */
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

  // React 19 resets uncontrolled fields on action settle (even on error).
  // Feed the submitted raw strings back as defaultValue so the user's
  // edits survive a validation failure instead of reverting to DB values.
  const fe = !state.ok ? (state.fieldErrors ?? {}) : {};
  const sv = !state.ok ? (state.values ?? {}) : {};
  const dv = (name: string, fallback: string) => sv[name] ?? fallback;

  // Toast on failure; navigate to detail view on success (the action
  // only revalidates — it does not redirect server-side).
  useEditFormResult(state, () => router.push(`/opportunities/${opportunity.id}`), "Opportunity updated");

  return (
    <form action={formAction} className="mt-6 grid gap-6 max-w-2xl">
      <input type="hidden" name="id" value={opportunity.id} />
      <input type="hidden" name="version" value={opportunity.version} />

      <StandardFormSection title="Details">
        <StandardFormField
          name="name"
          label="Name *"
          required
          maxLength={200}
          defaultValue={dv("name", opportunity.name)}
          error={fe.name}
        />
        <StandardFormRow>
          <StandardFormSelect
            name="stage"
            label="Stage"
            options={OPPORTUNITY_STAGES}
            defaultValue={dv("stage", opportunity.stage)}
            error={fe.stage}
          />
          {/* text + inputMode="decimal" (not type="number"): a number
              input blanks content the browser deems invalid, so a
              mistyped amount was silently dropped to null on save. */}
          <StandardFormField
            name="amount"
            label="Amount (USD)"
            type="text"
            inputMode="decimal"
            defaultValue={dv("amount", opportunity.amount ?? "")}
            error={fe.amount}
          />
        </StandardFormRow>
        {/* StandardFormField handles date picker internally for type="date" */}
        <StandardFormField
          name="expectedCloseDate"
          label="Expected close date"
          type="date"
          defaultValue={dv("expectedCloseDate", opportunity.expectedCloseDate ?? "")}
          error={fe.expectedCloseDate}
        />
      </StandardFormSection>

      <StandardFormSection title="Notes">
        <StandardFormTextarea
          name="description"
          label="Description"
          maxLength={4000}
          rows={5}
          defaultValue={dv("description", opportunity.description ?? "")}
          error={fe.description}
        />
      </StandardFormSection>

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
