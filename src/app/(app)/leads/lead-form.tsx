"use client";

import { useActionState } from "react";
import {
  createLeadAction,
  updateLeadAction,
  type ActionResult,
} from "./actions";
import {
  LEAD_RATINGS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "@/lib/lead-constants";

type LeadFormValues = {
  id?: string;
  salutation?: string | null;
  firstName: string;
  lastName: string;
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
  status: (typeof LEAD_STATUSES)[number];
  rating: (typeof LEAD_RATINGS)[number];
  source: (typeof LEAD_SOURCES)[number];
  estimatedValue?: string | null;
  estimatedCloseDate?: string | null;
  doNotContact: boolean;
  doNotEmail: boolean;
  doNotCall: boolean;
  tags?: string;
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
  const initial: ActionResult = { ok: true };
  const action = mode === "create" ? createLeadAction : updateLeadAction;
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult, fd: FormData) => action(fd),
    initial,
  );

  const v = lead ?? empty;

  return (
    <form action={formAction} className="mt-8 grid gap-6 lg:grid-cols-2">
      {mode === "edit" && lead?.id ? (
        <input type="hidden" name="id" value={lead.id} />
      ) : null}

      <Section title="Contact">
        <Row>
          <Input name="firstName" label="First name *" defaultValue={v.firstName} required />
          <Input name="lastName" label="Last name *" defaultValue={v.lastName} required />
        </Row>
        <Input name="jobTitle" label="Job title" defaultValue={v.jobTitle ?? ""} />
        <Row>
          <Input name="companyName" label="Company" defaultValue={v.companyName ?? ""} />
          <Input name="industry" label="Industry" defaultValue={v.industry ?? ""} />
        </Row>
        <Input name="email" label="Email" type="email" defaultValue={v.email ?? ""} />
        <Row>
          <Input name="phone" label="Phone" defaultValue={v.phone ?? ""} />
          <Input name="mobilePhone" label="Mobile" defaultValue={v.mobilePhone ?? ""} />
        </Row>
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
        <Input name="tags" label="Tags (comma-separated)" defaultValue={v.tags ?? ""} />
        <div className="flex flex-wrap gap-4 text-sm">
          <Checkbox name="doNotContact" label="Do not contact" defaultChecked={v.doNotContact} />
          <Checkbox name="doNotEmail" label="Do not email" defaultChecked={v.doNotEmail} />
          <Checkbox name="doNotCall" label="Do not call" defaultChecked={v.doNotCall} />
        </div>
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
        <label className="block text-xs uppercase tracking-wide text-white/50">
          Description
          <textarea
            name="description"
            defaultValue={v.description ?? ""}
            rows={6}
            className="mt-1 block w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
          />
        </label>
      </Section>

      {!state.ok ? (
        <div
          role="alert"
          className="rounded-md border border-rose-300/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 lg:col-span-2"
        >
          {state.error}
          {state.fieldErrors ? (
            <ul className="mt-2 list-disc pl-4 text-xs text-rose-100/80">
              {Object.entries(state.fieldErrors).map(([f, errs]) => (
                <li key={f}>
                  <strong>{f}:</strong> {errs?.join(", ")}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end gap-3 lg:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-white/90 px-5 py-2 text-sm font-medium text-slate-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
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
      className={`rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl ${wide ? "lg:col-span-2" : ""}`}
    >
      <h2 className="text-xs font-medium uppercase tracking-wide text-white/50">
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
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
  step?: string;
}) {
  return (
    <label className="block text-xs uppercase tracking-wide text-white/50">
      {label}
      <input
        name={name}
        type={type}
        step={step}
        defaultValue={defaultValue}
        required={required}
        className="mt-1 block w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
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
    <label className="block text-xs uppercase tracking-wide text-white/50">
      {label}
      <select
        name={name}
        defaultValue={defaultValue}
        className="mt-1 block w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-white/30 focus:outline-none focus:ring-2 focus:ring-white/20"
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

function Checkbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-white/20 bg-white/5 text-blue-500 focus:ring-blue-500"
      />
      <span>{label}</span>
    </label>
  );
}
