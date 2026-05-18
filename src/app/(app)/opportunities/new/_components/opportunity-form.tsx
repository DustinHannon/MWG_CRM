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
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Account *
          <select
            name="accountId"
            required
            defaultValue={sv.accountId ?? defaultAccountId ?? ""}
            className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="" disabled>
              — Select an account —
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {fe.accountId ? (
            <p role="alert" className="mt-1 text-xs text-[var(--status-lost-fg)]">
              {fe.accountId}
            </p>
          ) : null}
        </label>
        {contacts.length > 0 ? (
          <label className="block text-xs uppercase tracking-wide text-muted-foreground">
            Primary contact
            <select
              name="primaryContactId"
              defaultValue={sv.primaryContactId ?? ""}
              className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="">— No primary contact —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {[c.firstName, c.lastName].filter(Boolean).join(" ")}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </StandardFormSection>

      <StandardFormSection title="Pipeline">
        <StandardFormSelect
          name="stage"
          label="Stage"
          options={OPPORTUNITY_STAGES}
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
