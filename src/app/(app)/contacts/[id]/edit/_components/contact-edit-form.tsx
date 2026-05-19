"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { updateContactAction } from "../../../actions";
import type { ActionResult } from "@/lib/server-action";
import {
  StandardFormField,
  StandardFormTextarea,
  StandardFormSection,
  StandardFormRow,
  StandardFormCheckbox,
  useEditFormResult,
} from "@/components/standard";

/**
 * Contact edit form. OCC via hidden `version`.
 *
 * Visual note: input backgrounds are now `bg-muted/40` (shared
 * CONTROL_CLASS in standard-form) rather than the previous local
 * `bg-input/60`. Intentional unification — one token per CLAUDE.md §8.
 */
export function ContactEditForm({
  contact,
}: {
  contact: {
    id: string;
    version: number;
    firstName: string;
    lastName: string | null;
    jobTitle: string | null;
    email: string | null;
    phone: string | null;
    mobilePhone: string | null;
    description: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    birthdate: string | null;
    doNotEmail: boolean;
    doNotCall: boolean;
    doNotMail: boolean;
  };
}) {
  const router = useRouter();
  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => updateContactAction(fd), initial);

  // React 19 resets uncontrolled fields on action settle (even on error).
  // Feed the submitted raw strings back as defaultValue so the user's
  // edits survive a validation failure instead of reverting to DB values.
  const fe = !state.ok ? (state.fieldErrors ?? {}) : {};
  const sv = !state.ok ? (state.values ?? {}) : {};
  const dv = (name: string, fallback: string) => sv[name] ?? fallback;

  // Toast on failure; navigate to detail view on success (the action
  // only revalidates — it does not redirect server-side).
  useEditFormResult(state, () => router.push(`/contacts/${contact.id}`), "Contact updated");

  return (
    <form action={formAction} className="mt-6 grid gap-6 max-w-3xl">
      <input type="hidden" name="id" value={contact.id} />
      <input type="hidden" name="version" value={contact.version} />

      <StandardFormSection title="Identity">
        <StandardFormRow>
          <StandardFormField
            name="firstName"
            label="First name *"
            required
            maxLength={100}
            defaultValue={dv("firstName", contact.firstName)}
            error={fe.firstName}
          />
          <StandardFormField
            name="lastName"
            label="Last name"
            maxLength={100}
            defaultValue={dv("lastName", contact.lastName ?? "")}
            error={fe.lastName}
          />
        </StandardFormRow>
        <StandardFormRow>
          <StandardFormField
            name="jobTitle"
            label="Job title"
            maxLength={120}
            defaultValue={dv("jobTitle", contact.jobTitle ?? "")}
            error={fe.jobTitle}
          />
          {/* StandardFormField handles date picker internally for type="date" */}
          <StandardFormField
            name="birthdate"
            label="Birthdate"
            type="date"
            defaultValue={dv("birthdate", contact.birthdate ?? "")}
            error={fe.birthdate}
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
            defaultValue={dv("email", contact.email ?? "")}
            error={fe.email}
          />
          <StandardFormField
            name="phone"
            label="Phone"
            maxLength={40}
            defaultValue={dv("phone", contact.phone ?? "")}
            error={fe.phone}
          />
        </StandardFormRow>
        <StandardFormField
          name="mobilePhone"
          label="Mobile"
          maxLength={40}
          defaultValue={dv("mobilePhone", contact.mobilePhone ?? "")}
          error={fe.mobilePhone}
        />
      </StandardFormSection>

      <StandardFormSection title="Address">
        <StandardFormField
          name="street1"
          label="Street 1"
          maxLength={200}
          defaultValue={dv("street1", contact.street1 ?? "")}
          error={fe.street1}
        />
        <StandardFormField
          name="street2"
          label="Street 2"
          maxLength={200}
          defaultValue={dv("street2", contact.street2 ?? "")}
          error={fe.street2}
        />
        <div className="grid grid-cols-3 gap-4">
          <StandardFormField
            name="city"
            label="City"
            maxLength={120}
            defaultValue={dv("city", contact.city ?? "")}
            error={fe.city}
          />
          <StandardFormField
            name="state"
            label="State"
            maxLength={120}
            defaultValue={dv("state", contact.state ?? "")}
            error={fe.state}
          />
          <StandardFormField
            name="postalCode"
            label="Postal code"
            maxLength={20}
            defaultValue={dv("postalCode", contact.postalCode ?? "")}
            error={fe.postalCode}
          />
        </div>
        <StandardFormField
          name="country"
          label="Country"
          maxLength={80}
          defaultValue={dv("country", contact.country ?? "")}
          error={fe.country}
        />
      </StandardFormSection>

      <StandardFormSection title="Preferences">
        <div className="flex flex-wrap gap-4 text-sm">
          <StandardFormCheckbox
            name="doNotEmail"
            label="Do not email"
            defaultChecked={contact.doNotEmail}
          />
          <StandardFormCheckbox
            name="doNotCall"
            label="Do not call"
            defaultChecked={contact.doNotCall}
          />
          <StandardFormCheckbox
            name="doNotMail"
            label="Do not postal mail"
            defaultChecked={contact.doNotMail}
          />
        </div>
      </StandardFormSection>

      <StandardFormSection title="Notes">
        <StandardFormTextarea
          name="description"
          label="Description"
          maxLength={4000}
          rows={5}
          defaultValue={dv("description", contact.description ?? "")}
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
          onClick={() => router.push(`/contacts/${contact.id}`)}
          disabled={pending}
          className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
