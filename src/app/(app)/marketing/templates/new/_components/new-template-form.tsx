"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { createTemplateAction } from "../../actions";

/**
 * Phase 21 — Initial-create form. Posts to the server action; on
 * success redirects to the editor for the new id.
 */
export function NewTemplateForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createTemplateAction(formData);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/marketing/templates/${result.data.id}/edit`);
    });
  }

  return (
    <form
      action={handleSubmit}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6"
    >
      <Field
        label="Name"
        required
        input={
          <input
            name="name"
            type="text"
            required
            maxLength={200}
            disabled={pending}
            placeholder="e.g. Spring open-enrollment outreach"
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        }
        hint="Internal name. Recipients won't see it."
      />
      <Field
        label="Subject"
        required
        input={
          <input
            name="subject"
            type="text"
            required
            maxLength={998}
            disabled={pending}
            placeholder="e.g. Your benefits enrollment window opens Friday"
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        }
        hint="Shown in the recipient's inbox. Avoid all-caps and excessive punctuation."
      />
      <Field
        label="Preheader"
        input={
          <input
            name="preheader"
            type="text"
            maxLength={255}
            disabled={pending}
            placeholder="Optional preview text after the subject line"
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        }
        hint="Most clients show ~90 characters of preheader after the subject."
      />
      <Field
        label="Description"
        input={
          <textarea
            name="description"
            rows={3}
            maxLength={2000}
            disabled={pending}
            placeholder="Internal notes — who this is for, what it's about"
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        }
      />

      {error ? (
        <p className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-sm text-[var(--status-lost-fg)]">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground whitespace-nowrap transition hover:bg-primary/90 disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : null}
          {pending ? "Creating…" : "Continue to editor"}
        </button>
      </div>
    </form>
  );
}

interface FieldProps {
  label: string;
  input: React.ReactNode;
  required?: boolean;
  hint?: string;
}

function Field({ label, input, required, hint }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {required ? (
          <span className="ml-1 text-[var(--status-lost-fg)]" aria-hidden>
            *
          </span>
        ) : null}
      </span>
      {input}
      {hint ? (
        <span className="text-xs text-muted-foreground/80">{hint}</span>
      ) : null}
    </label>
  );
}
