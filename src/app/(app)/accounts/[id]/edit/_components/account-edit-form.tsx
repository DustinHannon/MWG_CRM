"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { updateAccountAction } from "../../../actions";
import type { ActionResult } from "@/lib/server-action";

/**
 * Account edit form. OCC via hidden `version`. Sectioned layout
 * matches the contact edit form for consistency. D365-parity fields
 * (account number, email, employees, annual revenue, full address,
 * parent account FK, primary contact FK) are editable here.
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

  useEffect(() => {
    if (state === initial) return;
    if (state.ok) {
      toast.success("Account updated");
      router.push(`/accounts/${account.id}`);
    } else {
      toast.error(state.error, { duration: Infinity, dismissible: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className="mt-6 grid gap-6 max-w-3xl">
      <input type="hidden" name="id" value={account.id} />
      <input type="hidden" name="version" value={account.version} />

      <Section title="Identity">
        <Field label="Name *">
          <input
            name="name"
            defaultValue={account.name}
            required
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Account number">
            <input
              name="accountNumber"
              defaultValue={account.accountNumber ?? ""}
              maxLength={100}
              className={inputClass}
            />
          </Field>
          <Field label="Industry">
            <input
              name="industry"
              defaultValue={account.industry ?? ""}
              maxLength={120}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Employees">
            <input
              type="number"
              name="numberOfEmployees"
              defaultValue={account.numberOfEmployees ?? ""}
              min={0}
              step={1}
              className={inputClass}
            />
          </Field>
          <Field label="Annual revenue ($)">
            <input
              type="number"
              name="annualRevenue"
              defaultValue={account.annualRevenue ?? ""}
              min={0}
              step="0.01"
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
              defaultValue={account.email ?? ""}
              maxLength={254}
              className={inputClass}
            />
          </Field>
          <Field label="Phone">
            <input
              name="phone"
              defaultValue={account.phone ?? ""}
              maxLength={40}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Website">
          <input
            name="website"
            defaultValue={account.website ?? ""}
            maxLength={200}
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title="Address">
        <Field label="Street 1">
          <input
            name="street1"
            defaultValue={account.street1 ?? ""}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <Field label="Street 2">
          <input
            name="street2"
            defaultValue={account.street2 ?? ""}
            maxLength={200}
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-3 gap-4">
          <Field label="City">
            <input
              name="city"
              defaultValue={account.city ?? ""}
              maxLength={120}
              className={inputClass}
            />
          </Field>
          <Field label="State">
            <input
              name="state"
              defaultValue={account.state ?? ""}
              maxLength={120}
              className={inputClass}
            />
          </Field>
          <Field label="Postal code">
            <input
              name="postalCode"
              defaultValue={account.postalCode ?? ""}
              maxLength={20}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Country">
          <input
            name="country"
            defaultValue={account.country ?? ""}
            maxLength={80}
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title="Relationships">
        <Field label="Parent account">
          <select
            name="parentAccountId"
            defaultValue={account.parentAccountId ?? ""}
            className={inputClass}
          >
            <option value="">— No parent —</option>
            {parentOptions.map((a) => (
              <option key={a.id} value={a.id} disabled={a.id === account.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Primary contact">
          <select
            name="primaryContactId"
            defaultValue={account.primaryContactId ?? ""}
            className={inputClass}
          >
            <option value="">— Not set —</option>
            {contactOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Notes">
        <Field label="Description">
          <textarea
            name="description"
            defaultValue={account.description ?? ""}
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
