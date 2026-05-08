"use client";

import { useActionState } from "react";
import { createOpportunityAction } from "../actions";
import type { ActionResult } from "@/lib/server-action";
import { OPPORTUNITY_STAGES } from "@/lib/opportunity-constants";

interface AccountOption {
  id: string;
  name: string;
}

interface ContactOption {
  id: string;
  firstName: string;
  lastName: string | null;
}

export function OpportunityForm({
  accounts,
  defaultAccountId,
  contacts,
}: {
  accounts: AccountOption[];
  defaultAccountId: string | null;
  contacts: ContactOption[];
}) {
  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => createOpportunityAction(fd), initial);

  return (
    <form action={formAction} className="mt-8 grid gap-6 lg:grid-cols-2">
      <Section title="Identity">
        <Input name="name" label="Opportunity name *" required />
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Account *
          <select
            name="accountId"
            required
            defaultValue={defaultAccountId ?? ""}
            className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            <option value="" disabled>
              — Select an account —
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {contacts.length > 0 ? (
          <label className="block text-xs uppercase tracking-wide text-muted-foreground">
            Primary contact
            <select
              name="primaryContactId"
              defaultValue=""
              className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
            >
              <option value="">— No primary contact —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {[c.firstName, c.lastName].filter(Boolean).join(" ")}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </Section>

      <Section title="Pipeline">
        <label className="block text-xs uppercase tracking-wide text-muted-foreground">
          Stage
          <select
            name="stage"
            defaultValue="prospecting"
            className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            {OPPORTUNITY_STAGES.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <Row>
          <Input
            name="amount"
            label="Amount (USD)"
            type="number"
            step="0.01"
          />
          <Input
            name="expectedCloseDate"
            label="Expected close date"
            type="date"
          />
        </Row>
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
          className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-sm text-[var(--status-lost-fg)] lg:col-span-2"
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
          {pending ? "Saving…" : "Create opportunity"}
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
  step,
  required,
}: {
  name: string;
  label: string;
  type?: string;
  step?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-xs uppercase tracking-wide text-muted-foreground">
      {label}
      <input
        name={name}
        type={type}
        step={step}
        required={required}
        className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  );
}
