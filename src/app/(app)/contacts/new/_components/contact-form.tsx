"use client";

import { useActionState } from "react";
import { createContactAction } from "../actions";
import type { ActionResult } from "@/lib/server-action";
import {
  StandardFormField,
  StandardFormTextarea,
  StandardFormSelect,
  StandardFormSection,
  StandardFormRow,
  StandardFormErrorBanner,
  StandardFormCheckbox,
} from "@/components/standard";

interface AccountOption {
  id: string;
  name: string;
}

export function ContactForm({
  accounts,
  defaultAccountId,
}: {
  accounts: AccountOption[];
  defaultAccountId: string | null;
}) {
  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => createContactAction(fd), initial);

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
        <StandardFormRow>
          <StandardFormField name="firstName" label="First name *" required defaultValue={dv("firstName")} error={fe.firstName} />
          <StandardFormField name="lastName" label="Last name" defaultValue={dv("lastName")} error={fe.lastName} />
        </StandardFormRow>
        <StandardFormField name="jobTitle" label="Job title" defaultValue={dv("jobTitle")} error={fe.jobTitle} />
      </StandardFormSection>

      <StandardFormSection title="Contact">
        <StandardFormField name="email" label="Email" type="email" defaultValue={dv("email")} error={fe.email} />
        <StandardFormRow>
          <StandardFormField name="phone" label="Phone" defaultValue={dv("phone")} error={fe.phone} />
          <StandardFormField name="mobilePhone" label="Mobile" defaultValue={dv("mobilePhone")} error={fe.mobilePhone} />
        </StandardFormRow>
        <StandardFormField name="birthdate" label="Birthdate" type="date" defaultValue={dv("birthdate")} error={fe.birthdate} />
      </StandardFormSection>

      <StandardFormSection title="Address" wide>
        <StandardFormField name="street1" label="Street 1" defaultValue={dv("street1")} error={fe.street1} />
        <StandardFormField name="street2" label="Street 2" defaultValue={dv("street2")} error={fe.street2} />
        <StandardFormRow>
          <StandardFormField name="city" label="City" defaultValue={dv("city")} error={fe.city} />
          <StandardFormField name="state" label="State" defaultValue={dv("state")} error={fe.state} />
        </StandardFormRow>
        <StandardFormRow>
          <StandardFormField name="postalCode" label="Postal code" defaultValue={dv("postalCode")} error={fe.postalCode} />
          <StandardFormField name="country" label="Country" defaultValue={dv("country")} error={fe.country} />
        </StandardFormRow>
      </StandardFormSection>

      <StandardFormSection title="Preferences" wide>
        <div className="flex flex-wrap gap-4 text-sm">
          <StandardFormCheckbox name="doNotEmail" label="Do not email" />
          <StandardFormCheckbox name="doNotCall" label="Do not call" />
          <StandardFormCheckbox name="doNotMail" label="Do not postal mail" />
        </div>
      </StandardFormSection>

      <StandardFormSection title="Account" wide>
        <StandardFormSelect
          name="accountId"
          label="Account"
          defaultValue={sv.accountId ?? defaultAccountId ?? ""}
          placeholderOption="— No account —"
          options={accounts.map((a) => ({ value: a.id, label: a.name }))}
        />
        <p className="text-xs text-muted-foreground">
          Up to 500 accounts shown. Edit the account from the contact
          detail page if the right one isn&apos;t listed.
        </p>
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
          {pending ? "Saving…" : "Create contact"}
        </button>
      </div>
    </form>
  );
}
