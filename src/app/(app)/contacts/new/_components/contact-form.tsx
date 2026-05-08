"use client";

import { useActionState } from "react";
import { createContactAction } from "../actions";
import type { ActionResult } from "@/lib/server-action";

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

  return (
    <form action={formAction} className="mt-8 grid gap-6 lg:grid-cols-2">
      <Section title="Identity">
        <Row>
          <Input name="firstName" label="First name *" required />
          <Input name="lastName" label="Last name" />
        </Row>
        <Input name="jobTitle" label="Job title" />
      </Section>

      <Section title="Contact">
        <Input name="email" label="Email" type="email" />
        <Row>
          <Input name="phone" label="Phone" />
          <Input name="mobilePhone" label="Mobile" />
        </Row>
      </Section>

      <Section title="Account" wide>
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Account
          <select
            name="accountId"
            defaultValue={defaultAccountId ?? ""}
            className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="">— No account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          Up to 500 accounts shown. Edit the account from the contact
          detail page if the right one isn&apos;t listed.
        </p>
      </Section>

      <Section title="Notes" wide>
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Description
          <textarea
            name="description"
            rows={5}
            className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
      </Section>

      {!state.ok ? (
        <div
          role="alert"
          className="rounded-md border border-rose-500/30 bg-rose-500/15 px-3 py-2 text-sm text-rose-700 dark:border-rose-300/30 dark:bg-rose-500/15 dark:text-rose-100 lg:col-span-2"
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
          {pending ? "Saving…" : "Create contact"}
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
  type = "text",
  required,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-xs uppercase tracking-wide text-muted-foreground">
      {label}
      <input
        name={name}
        type={type}
        required={required}
        className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  );
}
