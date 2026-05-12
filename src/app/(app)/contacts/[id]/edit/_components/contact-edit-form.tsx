"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { updateContactAction } from "../../../actions";
import type { ActionResult } from "@/lib/server-action";

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

  useEffect(() => {
    if (state === initial) return;
    if (state.ok) {
      toast.success("Contact updated");
      router.push(`/contacts/${contact.id}`);
    } else {
      toast.error(state.error, { duration: Infinity, dismissible: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className="mt-6 grid gap-6 max-w-3xl">
      <input type="hidden" name="id" value={contact.id} />
      <input type="hidden" name="version" value={contact.version} />

      <Section title="Identity">
        <div className="grid grid-cols-2 gap-4">
          <Field label="First name *">
            <input
              name="firstName"
              defaultValue={contact.firstName}
              required
              maxLength={100}
              className={inputClass}
            />
          </Field>
          <Field label="Last name">
            <input
              name="lastName"
              defaultValue={contact.lastName ?? ""}
              maxLength={100}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Job title">
            <input
              name="jobTitle"
              defaultValue={contact.jobTitle ?? ""}
              maxLength={120}
              className={inputClass}
            />
          </Field>
          <Field label="Birthdate">
            <input
              type="date"
              name="birthdate"
              defaultValue={contact.birthdate ?? ""}
              className={inputClass}
            />
          </Field>
        </div>
      </Section>

      <Section title="Contact info">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Email">
            <input
              type="email"
              name="email"
              defaultValue={contact.email ?? ""}
              maxLength={254}
              className={inputClass}
            />
          </Field>
          <Field label="Phone">
            <input
              name="phone"
              defaultValue={contact.phone ?? ""}
              maxLength={40}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Mobile">
          <input
            name="mobilePhone"
            defaultValue={contact.mobilePhone ?? ""}
            maxLength={40}
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title="Address">
        <Field label="Street 1">
          <input
            name="street1"
            defaultValue={contact.street1 ?? ""}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label="Street 2">
          <input
            name="street2"
            defaultValue={contact.street2 ?? ""}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-3 gap-4">
          <Field label="City">
            <input
              name="city"
              defaultValue={contact.city ?? ""}
              maxLength={120}
              className={inputClass}
            />
          </Field>
          <Field label="State">
            <input
              name="state"
              defaultValue={contact.state ?? ""}
              maxLength={120}
              className={inputClass}
            />
          </Field>
          <Field label="Postal code">
            <input
              name="postalCode"
              defaultValue={contact.postalCode ?? ""}
              maxLength={20}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Country">
          <input
            name="country"
            defaultValue={contact.country ?? ""}
            maxLength={80}
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title="Preferences">
        <div className="flex flex-wrap gap-4 text-sm">
          <Toggle name="doNotEmail" label="Do not email" defaultChecked={contact.doNotEmail} />
          <Toggle name="doNotCall" label="Do not call" defaultChecked={contact.doNotCall} />
          <Toggle name="doNotMail" label="Do not postal mail" defaultChecked={contact.doNotMail} />
        </div>
      </Section>

      <Section title="Notes">
        <Field label="Description">
          <textarea
            name="description"
            defaultValue={contact.description ?? ""}
            maxLength={4000}
            rows={5}
            className="rounded-md border border-border bg-input/60 px-3 py-2 text-sm"
          />
        </Field>
      </Section>

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

const inputClass =
  "h-9 rounded-md border border-border bg-input/60 px-3 text-sm";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}
