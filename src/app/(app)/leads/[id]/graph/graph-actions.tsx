"use client";

import { useActionState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { toast } from "sonner";
import { scheduleMeetingAction, sendEmailAction } from "./actions";
import type { ActionResult } from "@/lib/server-action";
import { StandardFormField, StandardFormTextarea } from "@/components/standard";

const initial: ActionResult = { ok: true };

function fieldErrors(state: ActionResult): Record<string, string> {
  return !state.ok ? state.fieldErrors ?? {} : {};
}

// React 19 resets the uncontrolled form once the action settles (even
// on error); echo the submitted values back as defaultValue so the
// reset restores them instead of blanking the form.
function submitted(state: ActionResult): Record<string, string> {
  return !state.ok ? state.values ?? {} : {};
}

export function EmailForm({
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

  // Fail-closed mailbox block also surfaces as a bottom-right toast
  // (the bell notification is written server-side). The inline
  // ErrorBox below still renders for all errors. No `state === initial`
  // guard (cf. the entity edit forms): this effect only fires on one
  // specific failure code, and the initial { ok: true } state can never
  // satisfy `!state.ok`, so it cannot fire on mount.
  useEffect(() => {
    if (!state.ok && state.code === "MAILBOX_UNSUPPORTED") {
      toast.error(state.error);
    }
  }, [state]);

  const fe = fieldErrors(state);
  const sv = submitted(state);

  return (
    <form action={action} className="flex flex-col gap-3" encType="multipart/form-data">
      <input type="hidden" name="leadId" value={leadId} />
      <StandardFormField
        name="to"
        label="To"
        type="email"
        defaultValue={sv.to ?? defaultEmail ?? ""}
        required
        error={fe.to}
      />
      <StandardFormField
        name="subject"
        label="Subject"
        required
        defaultValue={sv.subject ?? ""}
        error={fe.subject}
      />
      <StandardFormTextarea
        name="body"
        label="Body"
        rows={6}
        required
        defaultValue={sv.body ?? ""}
        error={fe.body}
      />
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

export function MeetingForm({
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

  // Fail-closed mailbox block also surfaces as a bottom-right toast
  // (the bell notification is written server-side). The inline
  // ErrorBox below still renders for all errors. No `state === initial`
  // guard (cf. the entity edit forms): this effect only fires on one
  // specific failure code, and the initial { ok: true } state can never
  // satisfy `!state.ok`, so it cannot fire on mount.
  useEffect(() => {
    if (!state.ok && state.code === "MAILBOX_UNSUPPORTED") {
      toast.error(state.error);
    }
  }, [state]);

  const fe = fieldErrors(state);
  const sv = submitted(state);

  return (
    <form action={action} className="grid gap-3 md:grid-cols-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="timeZone" value={defaultTimeZone} />
      <StandardFormField
        name="attendeeEmail"
        label="Attendee email"
        type="email"
        defaultValue={sv.attendeeEmail ?? defaultEmail ?? ""}
        required
        error={fe.attendeeEmail}
      />
      <StandardFormField
        name="attendeeName"
        label="Attendee name"
        defaultValue={sv.attendeeName ?? defaultName ?? ""}
        error={fe.attendeeName}
      />
      <div className="md:col-span-2">
        <StandardFormField
          name="subject"
          label="Subject"
          required
          defaultValue={sv.subject ?? ""}
          error={fe.subject}
        />
      </div>
      <StandardFormField
        name="startIso"
        label="Start"
        type="datetime-local"
        required
        defaultValue={sv.startIso ?? ""}
        error={fe.startIso}
      />
      <StandardFormField
        name="endIso"
        label="End"
        type="datetime-local"
        required
        defaultValue={sv.endIso ?? ""}
        error={fe.endIso}
      />
      <div className="md:col-span-2">
        <StandardFormField
          name="location"
          label="Location (optional)"
          defaultValue={sv.location ?? ""}
          error={fe.location}
        />
      </div>
      <div className="md:col-span-2">
        <StandardFormTextarea
          name="body"
          label="Agenda / notes"
          rows={3}
          defaultValue={sv.body ?? ""}
          error={fe.body}
        />
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
