"use client";

import { useActionState } from "react";
import { createAccountAction } from "../actions";
import type { ActionResult } from "@/lib/server-action";
import {
  StandardFormField,
  StandardFormTextarea,
  StandardFormSection,
  StandardFormRow,
  StandardFormErrorBanner,
} from "@/components/standard";

export function AccountForm() {
  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => createAccountAction(fd), initial);

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
        <StandardFormField name="name" label="Account name *" required defaultValue={dv("name")} error={fe.name} />
        <StandardFormRow>
          <StandardFormField name="accountNumber" label="Account number" defaultValue={dv("accountNumber")} error={fe.accountNumber} />
          <StandardFormField name="industry" label="Industry" defaultValue={dv("industry")} error={fe.industry} />
        </StandardFormRow>
        <StandardFormRow>
          {/* text + inputMode (not type="number") so a mistyped count
              round-trips and surfaces an inline error instead of being
              silently blanked by the browser and saved empty. */}
          <StandardFormField name="numberOfEmployees" label="Employees" type="text" inputMode="numeric" defaultValue={dv("numberOfEmployees")} error={fe.numberOfEmployees} />
          <StandardFormField name="annualRevenue" label="Annual revenue ($)" type="text" inputMode="decimal" defaultValue={dv("annualRevenue")} error={fe.annualRevenue} />
        </StandardFormRow>
      </StandardFormSection>

      <StandardFormSection title="Contact info">
        <StandardFormRow>
          <StandardFormField name="email" label="Email" type="email" defaultValue={dv("email")} error={fe.email} />
          <StandardFormField name="phone" label="Phone" defaultValue={dv("phone")} error={fe.phone} />
        </StandardFormRow>
        <StandardFormField name="website" label="Website" defaultValue={dv("website")} error={fe.website} />
      </StandardFormSection>

      <StandardFormSection title="Address">
        <StandardFormRow>
          <StandardFormField name="street1" label="Street 1" defaultValue={dv("street1")} error={fe.street1} />
          <StandardFormField name="street2" label="Street 2" defaultValue={dv("street2")} error={fe.street2} />
        </StandardFormRow>
        <StandardFormRow>
          <StandardFormField name="city" label="City" defaultValue={dv("city")} error={fe.city} />
          <StandardFormField name="state" label="State" defaultValue={dv("state")} error={fe.state} />
          <StandardFormField name="postalCode" label="Postal code" defaultValue={dv("postalCode")} error={fe.postalCode} />
        </StandardFormRow>
        <StandardFormField name="country" label="Country" defaultValue={dv("country")} error={fe.country} />
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
          {pending ? "Saving…" : "Create account"}
        </button>
      </div>
    </form>
  );
}
