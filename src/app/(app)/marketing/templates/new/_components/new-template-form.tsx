"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { createTemplateAction } from "../../actions";

/**
 * Initial-create form. Posts to the server action; on
 * success redirects to the editor for the new id.
 *
 * Adds the Visibility radio. Defaults to Global so
 * the existing pre-Phase-29 behavior is preserved unless the creator
 * explicitly chooses Personal.
 */
export function NewTemplateForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [scope, setScope] = useState<"global" | "personal">("global");

  function handleSubmit(formData: FormData) {
    setError(null);
    // The radio's `name="scope"` already includes the value via the
    // checked input; we re-stamp it from state to be defensive against
    // form serialization quirks (radio without an initial checked
    // attribute can land empty in some browser/RSC combos).
    formData.set("scope", scope);
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

      <VisibilityRadio
        value={scope}
        onChange={setScope}
        disabled={pending}
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

interface VisibilityRadioProps {
  value: "global" | "personal";
  onChange: (next: "global" | "personal") => void;
  disabled?: boolean;
}

/**
 * Visibility chooser used on the create form and the
 * editor toolbar. Renders two radio inputs styled as cards so the
 * description text is part of the click target.
 */
function VisibilityRadio({ value, onChange, disabled }: VisibilityRadioProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Visibility
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <VisibilityOption
          name="scope"
          value="global"
          checked={value === "global"}
          onChange={() => onChange("global")}
          disabled={disabled}
          label="Global"
          hint="Visible to everyone with template permissions."
        />
        <VisibilityOption
          name="scope"
          value="personal"
          checked={value === "personal"}
          onChange={() => onChange("personal")}
          disabled={disabled}
          label="Personal"
          hint="Only you can see and use this template."
        />
      </div>
    </fieldset>
  );
}

interface VisibilityOptionProps {
  name: string;
  value: "global" | "personal";
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  hint: string;
}

function VisibilityOption(props: VisibilityOptionProps) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition ${
        props.checked
          ? "border-ring/60 bg-accent/30"
          : "border-border bg-input hover:bg-accent/15"
      } ${props.disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        onChange={props.onChange}
        disabled={props.disabled}
        className="mt-0.5 h-4 w-4 border-border text-primary focus:ring-ring/40"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {props.label}
        </span>
        <span className="text-xs text-muted-foreground/80">{props.hint}</span>
      </span>
    </label>
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
