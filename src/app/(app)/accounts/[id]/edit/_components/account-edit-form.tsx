"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { updateAccountAction } from "../../../actions";
import type { ActionResult } from "@/lib/server-action";

/**
 * Phase 25 §7.4 — Account edit form. Pre-populated from the loaded
 * row; the row's `version` is sent in a hidden field so the server
 * action enforces OCC. On CONCURRENCY_CONFLICT, the error surfaces
 * as a toast; full diff-dialog integration is documented in
 * `src/components/standard/occ-conflict-dialog.tsx` for the next
 * iteration.
 */
export function AccountEditForm({
  account,
}: {
  account: {
    id: string;
    version: number;
    name: string;
    industry: string | null;
    website: string | null;
    phone: string | null;
    description: string | null;
  };
}) {
  const router = useRouter();
  const initial: ActionResult<never> = { ok: true };
  const [state, formAction, pending] = useActionState<
    ActionResult<never>,
    FormData
  >(async (_prev, fd) => updateAccountAction(fd), initial);

  // Surface ok/err via toast + redirect to the detail page on success.
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
    <form action={formAction} className="mt-6 grid gap-4 max-w-2xl">
      <input type="hidden" name="id" value={account.id} />
      <input type="hidden" name="version" value={account.version} />

      <Field name="name" label="Account name *" required>
        <input
          name="name"
          defaultValue={account.name}
          required
          maxLength={200}
          className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </Field>

      <Field name="industry" label="Industry">
        <input
          name="industry"
          defaultValue={account.industry ?? ""}
          maxLength={120}
          className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field name="website" label="Website">
          <input
            name="website"
            defaultValue={account.website ?? ""}
            maxLength={200}
            className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
          />
        </Field>
        <Field name="phone" label="Phone">
          <input
            name="phone"
            defaultValue={account.phone ?? ""}
            maxLength={40}
            className="h-9 rounded-md border border-border bg-input/60 px-3 text-sm"
          />
        </Field>
      </div>

      <Field name="description" label="Description">
        <textarea
          name="description"
          defaultValue={account.description ?? ""}
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

function Field({
  label,
  required,
  children,
}: {
  name: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
        {required ? " *" : ""}
      </span>
      {children}
    </label>
  );
}
