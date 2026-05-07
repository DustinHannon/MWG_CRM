"use client";

import { useActionState, useState } from "react";
import { createLeadAction, updateLeadAction } from "./actions";
import type { ActionResult } from "@/lib/server-action";
import { DuplicateWarning } from "@/components/leads/duplicate-warning";
import { TagInput } from "@/components/tags/tag-input";
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
  // Phase 8D Wave 6 (FIX-015) — `subject` is the legacy "Topic:" line.
  // The column shipped in Phase 6A; Wave 6 finally exposes it on the form.
  subject?: string | null;
  status: (typeof LEAD_STATUSES)[number];
  rating: (typeof LEAD_RATINGS)[number];
  source: (typeof LEAD_SOURCES)[number];
  estimatedValue?: string | null;
  estimatedCloseDate?: string | null;
  doNotContact: boolean;
  doNotEmail: boolean;
  doNotCall: boolean;
  // Phase 8D Wave 6 (FIX-016) — tags are now hydrated id+name+color so
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

export function LeadForm({
  mode,
  lead,
}: {
  mode: "create" | "edit";
  lead?: LeadFormValues;
}) {
  const initial: ActionResult<never> = { ok: true };
  const action = mode === "create" ? createLeadAction : updateLeadAction;
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => action(fd), initial);

  const v = lead ?? empty;
  // Phase 8D Wave 6 (FIX-016) — TagInput is controlled; selectedTags
  // round-trips into a hidden `tagIds` input the server action reads.
  const [selectedTags, setSelectedTags] = useState<SelectedTag[]>(
    v.tags ?? [],
  );

  return (
    <form action={formAction} className="mt-8 grid gap-6 lg:grid-cols-2">
      {mode === "edit" && lead?.id ? (
        <>
          <input type="hidden" name="id" value={lead.id} />
          {/* Phase 6B — version round-trips through the form so the
              server action can refuse stale concurrent writes. */}
          <input type="hidden" name="version" value={lead.version ?? 1} />
        </>
      ) : null}

      <Section title="Contact">
        <Row>
          <Input name="firstName" label="First name *" defaultValue={v.firstName} required />
          <Input name="lastName" label="Last name" defaultValue={v.lastName ?? ""} />
        </Row>
        <Input name="jobTitle" label="Job title" defaultValue={v.jobTitle ?? ""} />
        <Row>
          <Input name="companyName" label="Company" defaultValue={v.companyName ?? ""} />
          <Input name="industry" label="Industry" defaultValue={v.industry ?? ""} />
        </Row>
        <DuplicateAwareContact
          isCreate={v.id == null}
          defaultEmail={v.email ?? ""}
          defaultPhone={v.phone ?? ""}
          defaultMobilePhone={v.mobilePhone ?? ""}
        />
        <Input name="website" label="Website" defaultValue={v.website ?? ""} />
        <Input name="linkedinUrl" label="LinkedIn URL" defaultValue={v.linkedinUrl ?? ""} />
      </Section>

      <Section title="Pipeline">
        <Row>
          <Select name="status" label="Status" defaultValue={v.status} options={LEAD_STATUSES} />
          <Select name="rating" label="Rating" defaultValue={v.rating} options={LEAD_RATINGS} />
        </Row>
        <Select name="source" label="Source" defaultValue={v.source} options={LEAD_SOURCES} />
        <Row>
          <Input
            name="estimatedValue"
            label="Estimated value (USD)"
            type="number"
            step="0.01"
            defaultValue={v.estimatedValue ?? ""}
          />
          <Input
            name="estimatedCloseDate"
            label="Estimated close date"
            type="date"
            defaultValue={v.estimatedCloseDate ?? ""}
          />
        </Row>
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Tags
          <div className="mt-1">
            <TagInput
              value={selectedTags}
              onChange={setSelectedTags}
              hiddenInputName="tagIds"
            />
          </div>
        </label>
        <ContactPreferences
          initialDoNotContact={v.doNotContact}
          initialDoNotEmail={v.doNotEmail}
          initialDoNotCall={v.doNotCall}
        />
      </Section>

      <Section title="Address" wide>
        <Row>
          <Input name="street1" label="Street 1" defaultValue={v.street1 ?? ""} />
          <Input name="street2" label="Street 2" defaultValue={v.street2 ?? ""} />
        </Row>
        <Row>
          <Input name="city" label="City" defaultValue={v.city ?? ""} />
          <Input name="state" label="State" defaultValue={v.state ?? ""} />
          <Input name="postalCode" label="Postal code" defaultValue={v.postalCode ?? ""} />
        </Row>
        <Input name="country" label="Country" defaultValue={v.country ?? ""} />
      </Section>

      <Section title="Notes" wide>
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Subject
          <textarea
            name="subject"
            defaultValue={v.subject ?? ""}
            rows={2}
            maxLength={1000}
            placeholder="Brief one-line summary"
            className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Description
          <textarea
            name="description"
            defaultValue={v.description ?? ""}
            rows={6}
            className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
      </Section>

      {!state.ok ? (
        <div
          role="alert"
          className="rounded-md border border-rose-500/30 dark:border-rose-300/30 bg-rose-500/20 dark:bg-rose-500/15 dark:bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-100 lg:col-span-2"
        >
          {state.error}
        </div>
      ) : null}

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

function Section({
  title,
  children,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl ${wide ? "lg:col-span-2" : ""}`}
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

function Input({
  name,
  label,
  defaultValue,
  type = "text",
  required,
  step,
  onChange,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
  step?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="block text-xs uppercase tracking-wide text-muted-foreground">
      {label}
      <input
        name={name}
        type={type}
        onChange={onChange}
        step={step}
        defaultValue={defaultValue}
        required={required}
        className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  );
}

function Select({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: readonly string[];
}) {
  return (
    <label className="block text-xs uppercase tracking-wide text-muted-foreground">
      {label}
      <select
        name={name}
        defaultValue={defaultValue}
        className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
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
            className="h-4 w-4 rounded border-border bg-muted/40 text-blue-500 focus:ring-blue-500"
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
            className="h-4 w-4 rounded border-border bg-muted/40 text-blue-500 focus:ring-blue-500 disabled:cursor-not-allowed"
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
            className="h-4 w-4 rounded border-border bg-muted/40 text-blue-500 focus:ring-blue-500 disabled:cursor-not-allowed"
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
 * Phase 3F — wraps email + phone + mobile inputs with controlled state
 * so the DuplicateWarning component sees real-time changes. Only fires
 * the duplicate check on lead create (not on edit, where the active
 * lead would always self-match).
 */
function DuplicateAwareContact({
  isCreate,
  defaultEmail,
  defaultPhone,
  defaultMobilePhone,
}: {
  isCreate: boolean;
  defaultEmail: string;
  defaultPhone: string;
  defaultMobilePhone: string;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [phone, setPhone] = useState(defaultPhone);
  const [mobilePhone, setMobilePhone] = useState(defaultMobilePhone);

  return (
    <>
      <Input
        name="email"
        label="Email"
        type="email"
        defaultValue={defaultEmail}
        onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
      />
      <Row>
        <Input
          name="phone"
          label="Phone"
          defaultValue={defaultPhone}
          onChange={(e) => setPhone((e.target as HTMLInputElement).value)}
        />
        <Input
          name="mobilePhone"
          label="Mobile"
          defaultValue={defaultMobilePhone}
          onChange={(e) =>
            setMobilePhone((e.target as HTMLInputElement).value)
          }
        />
      </Row>
      {isCreate ? (
        <DuplicateWarning email={email} phone={phone || mobilePhone} />
      ) : null}
    </>
  );
}
