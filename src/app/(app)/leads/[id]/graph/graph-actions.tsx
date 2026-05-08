"use client";

import { useActionState, useState } from "react";
import { signIn } from "next-auth/react";
import { scheduleMeetingAction, sendEmailAction } from "./actions";
import type { ActionResult } from "@/lib/server-action";

const initial: ActionResult = { ok: true };

export function GraphActionPanel({
  leadId,
  defaultEmail,
  defaultName,
  defaultTimeZone,
}: {
  leadId: string;
  defaultEmail?: string | null;
  defaultName?: string | null;
  defaultTimeZone: string;
}) {
  const [tab, setTab] = useState<"email" | "meeting">("email");

  return (
    <div className="rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
      <div className="flex gap-2">
        <Pill active={tab === "email"} onClick={() => setTab("email")}>
          Send email
        </Pill>
        <Pill active={tab === "meeting"} onClick={() => setTab("meeting")}>
          Schedule meeting
        </Pill>
      </div>

      <div className="mt-4">
        {tab === "email" ? (
          <EmailForm leadId={leadId} defaultEmail={defaultEmail} />
        ) : (
          <MeetingForm
            leadId={leadId}
            defaultEmail={defaultEmail}
            defaultName={defaultName}
            defaultTimeZone={defaultTimeZone}
          />
        )}
      </div>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs uppercase tracking-wide transition ${
        active
          ? "bg-primary text-primary-foreground"
          : "border border-border bg-muted/40 text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

function EmailForm({
  leadId,
  defaultEmail,
}: {
  leadId: string;
  defaultEmail?: string | null;
}) {
  const [state, action, pending] = useActionState(
    async (_p: ActionResult, fd: FormData) => sendEmailAction(fd),
    initial,
  );

  return (
    <form action={action} className="flex flex-col gap-3" encType="multipart/form-data">
      <input type="hidden" name="leadId" value={leadId} />
      <Field name="to" label="To" type="email" defaultValue={defaultEmail ?? ""} required />
      <Field name="subject" label="Subject" required />
      <label className="text-xs uppercase tracking-wide text-muted-foreground">
        Body
        <textarea
          name="body"
          rows={6}
          required
          className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </label>
      <label className="text-xs uppercase tracking-wide text-muted-foreground">
        Attachments
        <input
          type="file"
          name="attachment"
          multiple
          className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground file:mr-3 file:rounded file:border-0 file:bg-primary file:px-2 file:py-1 file:text-xs file:font-medium file:text-primary-foreground"
        />
        <span className="text-[10px] text-muted-foreground/80">
          Up to 3MB per file (v1 limit; larger needs upload sessions).
        </span>
      </label>

      {!state.ok ? <ErrorBox state={state} /> : null}
      <Submit pending={pending} label="Send email" />
    </form>
  );
}

function MeetingForm({
  leadId,
  defaultEmail,
  defaultName,
  defaultTimeZone,
}: {
  leadId: string;
  defaultEmail?: string | null;
  defaultName?: string | null;
  defaultTimeZone: string;
}) {
  const [state, action, pending] = useActionState(
    async (_p: ActionResult, fd: FormData) => scheduleMeetingAction(fd),
    initial,
  );

  return (
    <form action={action} className="grid gap-3 md:grid-cols-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="timeZone" value={defaultTimeZone} />
      <Field
        name="attendeeEmail"
        label="Attendee email"
        type="email"
        defaultValue={defaultEmail ?? ""}
        required
      />
      <Field
        name="attendeeName"
        label="Attendee name"
        defaultValue={defaultName ?? ""}
      />
      <div className="md:col-span-2">
        <Field name="subject" label="Subject" required />
      </div>
      <Field name="startIso" label="Start" type="datetime-local" required />
      <Field name="endIso" label="End" type="datetime-local" required />
      <div className="md:col-span-2">
        <Field name="location" label="Location (optional)" />
      </div>
      <div className="md:col-span-2">
        <label className="text-xs uppercase tracking-wide text-muted-foreground">
          Agenda / notes
          <textarea
            name="body"
            rows={3}
            className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </label>
      </div>

      {!state.ok ? (
        <div className="md:col-span-2"><ErrorBox state={state} /></div>
      ) : null}
      <div className="md:col-span-2">
        <Submit pending={pending} label="Schedule meeting" />
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  defaultValue,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <label className="block text-xs uppercase tracking-wide text-muted-foreground">
      {label}
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
    </label>
  );
}

function Submit({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="self-end rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Working…" : label}
    </button>
  );
}

function ErrorBox({
  state,
}: {
  state: Extract<ActionResult, { ok: false }>;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-sm text-[var(--status-lost-fg)]"
    >
      {state.error}
      {state.code === "REAUTH_REQUIRED" ? (
        <>
          {" "}
          <button
            type="button"
            onClick={() =>
              signIn("microsoft-entra-id", {
                redirectTo: window.location.pathname,
              })
            }
            className="underline underline-offset-4"
          >
            Reconnect Microsoft →
          </button>
        </>
      ) : null}
    </div>
  );
}
