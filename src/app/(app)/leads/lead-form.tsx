"use client";

import { useActionState, useState } from "react";
import { createLeadAction, updateLeadAction } from "./actions";
import type { ActionResult } from "@/lib/server-action";
import { DuplicateWarning } from "@/components/leads/duplicate-warning";
import { TagInput } from "@/components/tags/tag-input";
import { TagSectionClient } from "@/components/tags/tag-section-client";
import {
  StandardFormField,
  StandardFormTextarea,
  StandardFormSelect,
  StandardFormSection,
  StandardFormRow,
  StandardFormErrorBanner,
} from "@/components/standard";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";

type SelectedTag = { id: string; name: string; color: string };

type LeadFormValues = {
  id?: string;
  version?: number;
  salutation?: string | null;
  firstName: string;
  lastName?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
  industry?: string | null;
  email?: string | null;
  phone?: string | null;
  mobilePhone?: string | null;
  website?: string | null;
  linkedinUrl?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  description?: string | null;
  // `subject` is the legacy "Topic:" line.
  subject?: string | null;
  status: (typeof LEAD_STATUSES)[number];
  rating: (typeof LEAD_RATINGS)[number];
  source: (typeof LEAD_SOURCES)[number];
  estimatedValue?: string | null;
  estimatedCloseDate?: string | null;
  doNotContact: boolean;
  doNotEmail: boolean;
  doNotCall: boolean;
  // tags are now hydrated id+name+color so
  // the TagInput combobox can render chips and round-trip selections.
  tags?: SelectedTag[];
};

const empty: LeadFormValues = {
  firstName: "",
  lastName: "",
  status: "new",
  rating: "warm",
  source: "other",
  doNotContact: false,
  doNotEmail: false,
  doNotCall: false,
};

type StrMap = Record<string, string>;

export function LeadForm({
  mode,
  lead,
  canApplyTags,
  canManageTagDefinitions,
}: {
  mode: "create" | "edit";
  lead?: LeadFormValues;
  /** Tag permissions resolved server-side; only consumed in edit mode. */
  canApplyTags?: boolean;
  canManageTagDefinitions?: boolean;
}) {
  const initial: ActionResult<never> = { ok: true };
  const action = mode === "create" ? createLeadAction : updateLeadAction;
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => action(fd), initial);

  const v = lead ?? empty;
  // Per-field validation messages, and the raw values the user
  // submitted. React 19 resets uncontrolled fields once the action
  // settles (even on error); feeding the submitted value back as
  // `defaultValue` makes that reset restore the input instead of
  // blanking it. Never blank a form on a validation error.
  const fe: StrMap = !state.ok ? state.fieldErrors ?? {} : {};
  const sv: StrMap = !state.ok ? state.values ?? {} : {};
  const dv = (name: string, fallback: string) => sv[name] ?? fallback;
  // TagInput is controlled; selectedTags
  // round-trips into a hidden `tagIds` input the server action reads.
  const [selectedTags, setSelectedTags] = useState<SelectedTag[]>(
    v.tags ?? [],
  );

  return (
    <form action={formAction} className="mt-8 grid gap-6 lg:grid-cols-2">
      {mode === "edit" && lead?.id ? (
        <>
          <input type="hidden" name="id" value={lead.id} />
          {/* version round-trips through the form so the
              server action can refuse stale concurrent writes. */}
          <input type="hidden" name="version" value={lead.version ?? 1} />
        </>
      ) : null}

      <StandardFormSection title="Contact">
        <StandardFormRow>
          <StandardFormField name="firstName" label="First name *" defaultValue={dv("firstName", v.firstName)} required error={fe.firstName} />
          <StandardFormField name="lastName" label="Last name" defaultValue={dv("lastName", v.lastName ?? "")} error={fe.lastName} />
        </StandardFormRow>
        <StandardFormField name="jobTitle" label="Job title" defaultValue={dv("jobTitle", v.jobTitle ?? "")} error={fe.jobTitle} />
        <StandardFormRow>
          <StandardFormField name="companyName" label="Company" defaultValue={dv("companyName", v.companyName ?? "")} error={fe.companyName} />
          <StandardFormField name="industry" label="Industry" defaultValue={dv("industry", v.industry ?? "")} error={fe.industry} />
        </StandardFormRow>
        <DuplicateAwareContact
          isCreate={v.id == null}
          defaultEmail={dv("email", v.email ?? "")}
          defaultPhone={dv("phone", v.phone ?? "")}
          defaultMobilePhone={dv("mobilePhone", v.mobilePhone ?? "")}
          fe={fe}
        />
        <StandardFormField name="website" label="Website" defaultValue={dv("website", v.website ?? "")} error={fe.website} />
        <StandardFormField name="linkedinUrl" label="LinkedIn URL" defaultValue={dv("linkedinUrl", v.linkedinUrl ?? "")} error={fe.linkedinUrl} />
      </StandardFormSection>

      <StandardFormSection title="Pipeline">
        <StandardFormRow>
          <StandardFormSelect name="status" label="Status" defaultValue={dv("status", v.status)} options={LEAD_STATUSES} error={fe.status} />
          <StandardFormSelect name="rating" label="Rating" defaultValue={dv("rating", v.rating)} options={LEAD_RATINGS} error={fe.rating} />
        </StandardFormRow>
        <StandardFormSelect name="source" label="Source" defaultValue={dv("source", v.source)} options={LEAD_SOURCES} error={fe.source} />
        <StandardFormRow>
          {/* Money is text + inputMode="decimal", NOT type="number":
              a native number input blanks content the browser deems
              invalid, so a mistyped amount used to vanish silently.
              Now the value round-trips and a bad entry surfaces an
              inline error instead of saving an empty field. */}
          <StandardFormField
            name="estimatedValue"
            label="Estimated value (USD)"
            type="text"
            inputMode="decimal"
            defaultValue={dv("estimatedValue", v.estimatedValue ?? "")}
            error={fe.estimatedValue}
          />
          <StandardFormField
            name="estimatedCloseDate"
            label="Estimated close date"
            type="date"
            defaultValue={dv("estimatedCloseDate", v.estimatedCloseDate ?? "")}
            error={fe.estimatedCloseDate}
          />
        </StandardFormRow>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">Tags</h3>
          <div className="mt-2">
            {mode === "edit" && lead?.id ? (
              <TagSectionClient
                entityType="lead"
                entityId={lead.id}
                initialTags={selectedTags}
                canApply={canApplyTags ?? false}
                canManage={canManageTagDefinitions ?? false}
              />
            ) : canApplyTags ? (
              <TagInput
                value={selectedTags}
                onChange={setSelectedTags}
                hiddenInputName="tagIds"
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                You don&apos;t have permission to apply tags.
              </p>
            )}
          </div>
        </div>
        <ContactPreferences
          initialDoNotContact={v.doNotContact}
          initialDoNotEmail={v.doNotEmail}
          initialDoNotCall={v.doNotCall}
        />
      </StandardFormSection>

      <StandardFormSection title="Address" wide>
        <StandardFormRow>
          <StandardFormField name="street1" label="Street 1" defaultValue={dv("street1", v.street1 ?? "")} error={fe.street1} />
          <StandardFormField name="street2" label="Street 2" defaultValue={dv("street2", v.street2 ?? "")} error={fe.street2} />
        </StandardFormRow>
        <StandardFormRow>
          <StandardFormField name="city" label="City" defaultValue={dv("city", v.city ?? "")} error={fe.city} />
          <StandardFormField name="state" label="State" defaultValue={dv("state", v.state ?? "")} error={fe.state} />
          <StandardFormField name="postalCode" label="Postal code" defaultValue={dv("postalCode", v.postalCode ?? "")} error={fe.postalCode} />
        </StandardFormRow>
        <StandardFormField name="country" label="Country" defaultValue={dv("country", v.country ?? "")} error={fe.country} />
      </StandardFormSection>

      <StandardFormSection title="Notes" wide>
        <StandardFormTextarea
          name="subject"
          label="Subject"
          defaultValue={dv("subject", v.subject ?? "")}
          rows={2}
          maxLength={1000}
          placeholder="Brief one-line summary"
          error={fe.subject}
        />
        <StandardFormTextarea
          name="description"
          label="Description"
          defaultValue={dv("description", v.description ?? "")}
          rows={6}
          error={fe.description}
        />
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
          {pending ? "Saving…" : mode === "create" ? "Create lead" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

/**
 * Do Not Contact implies Do Not Email AND Do Not Call. When DNC is checked,
 * auto-check both child boxes and disable them so the user can't toggle
 * them back on. When DNC is un-checked, restore the children to whatever
 * the user had set before — so a "Do Not Email but allow calls" choice
 * survives toggling DNC twice.
 *
 * Server-side zod refinement (see leadCreateSchema in lib/leads.ts)
 * rejects any submission where do_not_contact=true with do_not_email=false
 * or do_not_call=false — defends against a forged form bypassing this UX.
 */
function ContactPreferences({
  initialDoNotContact,
  initialDoNotEmail,
  initialDoNotCall,
}: {
  initialDoNotContact: boolean;
  initialDoNotEmail: boolean;
  initialDoNotCall: boolean;
}) {
  const [dnc, setDnc] = useState(initialDoNotContact);
  // The user's "real" choices for email / call — restored when DNC is off.
  const [userEmail, setUserEmail] = useState(initialDoNotEmail);
  const [userCall, setUserCall] = useState(initialDoNotCall);

  const effectiveEmail = dnc ? true : userEmail;
  const effectiveCall = dnc ? true : userCall;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="doNotContact"
            checked={dnc}
            onChange={(e) => setDnc(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring"
          />
          <span className="font-medium">Do not contact</span>
        </label>

        <label
          className={`flex items-center gap-2 ${dnc ? "opacity-50" : ""}`}
          aria-disabled={dnc}
        >
          <input
            type="checkbox"
            name="doNotEmail"
            checked={effectiveEmail}
            onChange={(e) => setUserEmail(e.target.checked)}
            disabled={dnc}
            className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring disabled:cursor-not-allowed"
          />
          <span>Do not email</span>
        </label>

        <label
          className={`flex items-center gap-2 ${dnc ? "opacity-50" : ""}`}
          aria-disabled={dnc}
        >
          <input
            type="checkbox"
            name="doNotCall"
            checked={effectiveCall}
            onChange={(e) => setUserCall(e.target.checked)}
            disabled={dnc}
            className="h-4 w-4 rounded border-border bg-muted/40 text-primary focus:ring-ring disabled:cursor-not-allowed"
          />
          <span>Do not call</span>
        </label>
      </div>
      {dnc ? (
        <p className="text-xs text-muted-foreground/80">
          Do Not Email and Do Not Call are implied by Do Not Contact.
        </p>
      ) : null}
    </div>
  );
}

/**
 * wraps email + phone + mobile inputs with controlled state
 * so the DuplicateWarning component sees real-time changes. Only fires
 * the duplicate check on lead create (not on edit, where the active
 * lead would always self-match).
 */
function DuplicateAwareContact({
  isCreate,
  defaultEmail,
  defaultPhone,
  defaultMobilePhone,
  fe,
}: {
  isCreate: boolean;
  defaultEmail: string;
  defaultPhone: string;
  defaultMobilePhone: string;
  fe: StrMap;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [phone, setPhone] = useState(defaultPhone);
  const [mobilePhone, setMobilePhone] = useState(defaultMobilePhone);

  return (
    <>
      <StandardFormField
        name="email"
        label="Email"
        type="email"
        defaultValue={defaultEmail}
        error={fe.email}
        onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
      />
      <StandardFormRow>
        <StandardFormField
          name="phone"
          label="Phone"
          defaultValue={defaultPhone}
          error={fe.phone}
          onChange={(e) => setPhone((e.target as HTMLInputElement).value)}
        />
        <StandardFormField
          name="mobilePhone"
          label="Mobile"
          defaultValue={defaultMobilePhone}
          error={fe.mobilePhone}
          onChange={(e) =>
            setMobilePhone((e.target as HTMLInputElement).value)
          }
        />
      </StandardFormRow>
      {isCreate ? (
        <DuplicateWarning email={email} phone={phone || mobilePhone} />
      ) : null}
    </>
  );
}
