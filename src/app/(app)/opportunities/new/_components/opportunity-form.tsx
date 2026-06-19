"use client";

import { useActionState } from "react";
import { createOpportunityAction } from "../actions";
import type { ActionResult } from "@/lib/server-action";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";
import {
  StandardFormField,
  StandardFormTextarea,
  StandardFormSelect,
  StandardFormSection,
  StandardFormRow,
  StandardFormErrorBanner,
} from "@/components/standard";

// Display labels for the opportunity_stage enum. Title-case to match
// the pipeline board's stage headings so the create form, filter bar,
// and board read the same way. Derived from OPPORTUNITY_STAGES so a new
// enum member surfaces here even before a label is added.
const STAGE_LABELS: Record<string, string> = {
  prospecting: "Prospecting",
  qualification: "Qualification",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
};

const STAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  OPPORTUNITY_STAGES.map((s) => ({
    value: s,
    label: STAGE_LABELS[s] ?? s.replaceAll("_", " "),
  }));

interface AccountOption {
  id: string;
  name: string;
}

interface ContactOption {
  id: string;
  firstName: string;
  lastName: string | null;
}

export function OpportunityForm({
  accounts,
  defaultAccountId,
  contacts,
}: {
  accounts: AccountOption[];
  defaultAccountId: string | null;
  contacts: ContactOption[];
}) {
  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => createOpportunityAction(fd), initial);

  const fe: Record<string, string> = !state.ok
    ? state.fieldErrors ?? {}
    : {};
  // Echo submitted values so React 19's post-action form reset
  // restores them instead of blanking the form on a validation error.
  const sv: Record<string, string> = !state.ok ? state.values ?? {} : {};
  const dv = (name: string) => sv[name] ?? "";

  return (
    <form action={formAction} className="mt-8 grid gap-6 lg:grid-cols-2">
      <StandardFormSection title="Identity">
        <StandardFormField name="name" label="Opportunity name *" required defaultValue={dv("name")} error={fe.name} />
        <StandardFormSelect
          name="accountId"
          label="Account *"
          required
          placeholderOption="— Select an account —"
          options={accounts.map((a) => ({ value: a.id, label: a.name }))}
          defaultValue={sv.accountId ?? defaultAccountId ?? ""}
          error={fe.accountId}
        />
        {contacts.length > 0 ? (
          <StandardFormSelect
            name="primaryContactId"
            label="Primary contact"
            placeholderOption="— No primary contact —"
            options={contacts.map((c) => ({
              value: c.id,
              label: [c.firstName, c.lastName].filter(Boolean).join(" "),
            }))}
            defaultValue={sv.primaryContactId ?? ""}
          />
        ) : (
          <StandardFormSelect
            name="primaryContactId"
            label="Primary contact"
            placeholderOption="Select an account to choose a contact"
            options={[]}
            defaultValue=""
          />
        )}
      </StandardFormSection>

      <StandardFormSection title="Pipeline">
        <StandardFormSelect
          name="stage"
          label="Stage"
          options={STAGE_OPTIONS}
          defaultValue={sv.stage ?? "prospecting"}
          error={fe.stage}
        />
        <StandardFormRow>
          {/* text + inputMode="decimal" (not type="number") so a
              mistyped amount round-trips and surfaces an inline error
              instead of being silently dropped. */}
          <StandardFormField
            name="amount"
            label="Amount (USD)"
            type="text"
            inputMode="decimal"
            defaultValue={dv("amount")}
            error={fe.amount}
          />
          <StandardFormField
            name="expectedCloseDate"
            label="Expected close date"
            type="date"
            defaultValue={dv("expectedCloseDate")}
            error={fe.expectedCloseDate}
          />
        </StandardFormRow>
      </StandardFormSection>

      <StandardFormSection title="Notes" wide>
        <StandardFormTextarea name="description" label="Description" rows={5} defaultValue={dv("description")} error={fe.description} />
      </StandardFormSection>

      <StandardFormErrorBanner
        message={!state.ok ? state.error : undefined}
        className="lg:col-span-2"
      />

      <div className="flex justify-end gap-3 lg:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving…" : "Create opportunity"}
        </button>
      </div>
    </form>
  );
}
