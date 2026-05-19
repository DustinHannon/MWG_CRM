"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { updateAccountAction } from "../../../actions";
import type { ActionResult } from "@/lib/server-action";
import {
  StandardFormField,
  StandardFormTextarea,
  StandardFormSelect,
  StandardFormSection,
  StandardFormRow,
  useEditFormResult,
} from "@/components/standard";

/**
 * Account edit form. OCC via hidden `version`. Sectioned layout
 * matches the contact edit form for consistency. D365-parity fields
 * (account number, email, employees, annual revenue, full address,
 * parent account FK, primary contact FK) are editable here.
 *
 * Visual note: input backgrounds are now `bg-muted/40` (shared
 * CONTROL_CLASS in standard-form) rather than the previous local
 * `bg-input/60`. Intentional unification — one token per CLAUDE.md §8.
 */
export function AccountEditForm({
  account,
  contactOptions,
  parentOptions,
}: {
  account: {
    id: string;
    version: number;
    name: string;
    industry: string | null;
    website: string | null;
    phone: string | null;
    email: string | null;
    accountNumber: string | null;
    numberOfEmployees: number | null;
    annualRevenue: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    description: string | null;
    parentAccountId: string | null;
    primaryContactId: string | null;
  };
  contactOptions: Array<{ id: string; name: string }>;
  parentOptions: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => updateAccountAction(fd), initial);

  // React 19 resets uncontrolled fields on action settle (even on error).
  // Feed the submitted raw strings back as defaultValue so the user's
  // edits survive a validation failure instead of reverting to DB values.
  const fe = !state.ok ? (state.fieldErrors ?? {}) : {};
  const sv = !state.ok ? (state.values ?? {}) : {};
  const dv = (name: string, fallback: string) => sv[name] ?? fallback;

  // Toast on failure; navigate to detail view on success (the action
  // only revalidates — it does not redirect server-side).
  useEditFormResult(state, () => router.push(`/accounts/${account.id}`), "Account updated");

  return (
    <form action={formAction} className="mt-6 grid gap-6 max-w-3xl">
      <input type="hidden" name="id" value={account.id} />
      <input type="hidden" name="version" value={account.version} />

      <StandardFormSection title="Identity">
        <StandardFormField
          name="name"
          label="Name *"
          required
          maxLength={200}
          defaultValue={dv("name", account.name)}
          error={fe.name}
        />
        <StandardFormRow>
          <StandardFormField
            name="accountNumber"
            label="Account number"
            maxLength={100}
            defaultValue={dv("accountNumber", account.accountNumber ?? "")}
            error={fe.accountNumber}
          />
          <StandardFormField
            name="industry"
            label="Industry"
            maxLength={120}
            defaultValue={dv("industry", account.industry ?? "")}
            error={fe.industry}
          />
        </StandardFormRow>
        <StandardFormRow>
          {/* text + inputMode (not type="number"): a number input
              blanks content the browser deems invalid, so a mistyped
              value was silently dropped to null on save. */}
          <StandardFormField
            name="numberOfEmployees"
            label="Employees"
            type="text"
            inputMode="numeric"
            defaultValue={dv("numberOfEmployees", account.numberOfEmployees != null ? String(account.numberOfEmployees) : "")}
            error={fe.numberOfEmployees}
          />
          <StandardFormField
            name="annualRevenue"
            label="Annual revenue ($)"
            type="text"
            inputMode="decimal"
            defaultValue={dv("annualRevenue", account.annualRevenue ?? "")}
            error={fe.annualRevenue}
          />
        </StandardFormRow>
      </StandardFormSection>

      <StandardFormSection title="Contact info">
        <StandardFormRow>
          <StandardFormField
            name="email"
            label="Email"
            type="email"
            maxLength={254}
            defaultValue={dv("email", account.email ?? "")}
            error={fe.email}
          />
          <StandardFormField
            name="phone"
            label="Phone"
            maxLength={40}
            defaultValue={dv("phone", account.phone ?? "")}
            error={fe.phone}
          />
        </StandardFormRow>
        <StandardFormField
          name="website"
          label="Website"
          maxLength={200}
          defaultValue={dv("website", account.website ?? "")}
          error={fe.website}
        />
      </StandardFormSection>

      <StandardFormSection title="Address">
        <StandardFormField
          name="street1"
          label="Street 1"
          maxLength={200}
          defaultValue={dv("street1", account.street1 ?? "")}
          error={fe.street1}
        />
        <StandardFormField
          name="street2"
          label="Street 2"
          maxLength={200}
          defaultValue={dv("street2", account.street2 ?? "")}
          error={fe.street2}
        />
        <div className="grid grid-cols-3 gap-4">
          <StandardFormField
            name="city"
            label="City"
            maxLength={120}
            defaultValue={dv("city", account.city ?? "")}
            error={fe.city}
          />
          <StandardFormField
            name="state"
            label="State"
            maxLength={120}
            defaultValue={dv("state", account.state ?? "")}
            error={fe.state}
          />
          <StandardFormField
            name="postalCode"
            label="Postal code"
            maxLength={20}
            defaultValue={dv("postalCode", account.postalCode ?? "")}
            error={fe.postalCode}
          />
        </div>
        <StandardFormField
          name="country"
          label="Country"
          maxLength={80}
          defaultValue={dv("country", account.country ?? "")}
          error={fe.country}
        />
      </StandardFormSection>

      <StandardFormSection title="Relationships">
        <StandardFormSelect
          name="parentAccountId"
          label="Parent account"
          options={parentOptions
            .filter((a) => a.id !== account.id)
            .map((a) => ({ value: a.id, label: a.name }))}
          placeholderOption="— No parent —"
          defaultValue={dv("parentAccountId", account.parentAccountId ?? "")}
          error={fe.parentAccountId}
        />
        <StandardFormSelect
          name="primaryContactId"
          label="Primary contact"
          options={contactOptions.map((c) => ({ value: c.id, label: c.name }))}
          placeholderOption="— Not set —"
          defaultValue={dv("primaryContactId", account.primaryContactId ?? "")}
          error={fe.primaryContactId}
        />
      </StandardFormSection>

      <StandardFormSection title="Notes">
        <StandardFormTextarea
          name="description"
          label="Description"
          maxLength={4000}
          rows={5}
          defaultValue={dv("description", account.description ?? "")}
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
          onClick={() => router.push(`/accounts/${account.id}`)}
          disabled={pending}
          className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
