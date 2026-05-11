"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { updateContactAction } from "../../../actions";
import type { ActionResult } from "@/lib/server-action";

/** Phase 25 §7.4 — Contact edit form. Same shape as AccountEditForm. */
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
    description: string | null;
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
    <form action={formAction} className="mt-6 grid gap-4 max-w-2xl">
      <input type="hidden" name="id" value={contact.id} />
      <input type="hidden" name="version" value={contact.version} />

      <div className="grid grid-cols-2 gap-4">
        <Field label="First name *">
          <input
            name="firstName"
            defaultValue={contact.firstName}
            required
            maxLength={100}
            className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
          />
        </Field>
        <Field label="Last name">
          <input
            name="lastName"
            defaultValue={contact.lastName ?? ""}
            maxLength={100}
            className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
          />
        </Field>
      </div>

      <Field label="Job title">
        <input
          name="jobTitle"
          defaultValue={contact.jobTitle ?? ""}
          maxLength={120}
          className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Email">
          <input
            type="email"
            name="email"
            defaultValue={contact.email ?? ""}
            maxLength={254}
            className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
          />
        </Field>
        <Field label="Phone">
          <input
            name="phone"
            defaultValue={contact.phone ?? ""}
            maxLength={40}
            className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea
          name="description"
          defaultValue={contact.description ?? ""}
          maxLength={4000}
          rows={5}
          className="rounded-md border border-border bg-input/60 px-3 py-2 text-sm"
        />
      </Field>

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
