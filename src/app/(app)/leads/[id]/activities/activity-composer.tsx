"use client";

import { useActionState } from "react";
import {
  addCallAction,
  addNoteAction,
  addTaskAction,
} from "./actions";
import type { ActionResult } from "@/lib/server-action";
import {
  StandardFormField,
  StandardFormTextarea,
  StandardFormSelect,
  StandardFormErrorBanner,
} from "@/components/standard";

const initial: ActionResult = { ok: true };

function fieldErrors(state: ActionResult): Record<string, string> {
  return !state.ok ? state.fieldErrors ?? {} : {};
}

// React 19 resets the uncontrolled form once the action settles (even
// on error); echo the submitted values back as defaultValue so the
// reset restores them instead of blanking the composer.
function submitted(state: ActionResult): Record<string, string> {
  return !state.ok ? state.values ?? {} : {};
}

export function NoteForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(
    async (_p: ActionResult, fd: FormData) => addNoteAction(fd),
    initial,
  );
  const fe = fieldErrors(state);
  const sv = submitted(state);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <StandardFormTextarea
        name="body"
        label="Note"
        rows={4}
        required
        placeholder="Write a note about this lead…"
        defaultValue={sv.body ?? ""}
        error={fe.body}
      />
      <StandardFormErrorBanner message={!state.ok ? state.error : undefined} />
      <Submit pending={pending} label="Add note" />
    </form>
  );
}

export function CallForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(
    async (_p: ActionResult, fd: FormData) => addCallAction(fd),
    initial,
  );
  const fe = fieldErrors(state);
  const sv = submitted(state);
  return (
    <form action={action} className="grid gap-3 md:grid-cols-2">
      <input type="hidden" name="leadId" value={leadId} />
      <StandardFormField name="subject" label="Subject" defaultValue={sv.subject ?? ""} error={fe.subject} />
      <StandardFormSelect
        name="outcome"
        label="Outcome"
        placeholderOption="—"
        defaultValue={sv.outcome ?? ""}
        options={[
          "spoke",
          "left voicemail",
          "no answer",
          "scheduled callback",
          "wrong number",
        ]}
        error={fe.outcome}
      />
      <StandardFormField
        name="durationMinutes"
        label="Duration (min)"
        type="text"
        inputMode="numeric"
        defaultValue={sv.durationMinutes ?? ""}
        error={fe.durationMinutes}
      />
      <StandardFormField
        name="occurredAt"
        label="When"
        type="datetime-local"
        defaultValue={sv.occurredAt ?? ""}
        error={fe.occurredAt}
      />
      <div className="md:col-span-2">
        <StandardFormTextarea
          name="body"
          label="Notes"
          rows={3}
          placeholder="What was discussed?"
          defaultValue={sv.body ?? ""}
          error={fe.body}
        />
      </div>
      {!state.ok && state.error ? (
        <div className="md:col-span-2">
          <StandardFormErrorBanner message={state.error} />
        </div>
      ) : null}
      <div className="md:col-span-2">
        <Submit pending={pending} label="Log call" />
      </div>
    </form>
  );
}

export function TaskForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(
    async (_p: ActionResult, fd: FormData) => addTaskAction(fd),
    initial,
  );
  const fe = fieldErrors(state);
  const sv = submitted(state);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <StandardFormField name="subject" label="Subject" required defaultValue={sv.subject ?? ""} error={fe.subject} />
      {/* Date-only "Due date" — matches the canonical task-due input
          (entity-tasks-quick-add, task-edit-dialog). The old
          datetime-local read like free text, so "Thursday 2pm" was
          rejected by the browser and the task saved with no due date.
          A native date input cannot accept free text. */}
      <StandardFormField
        name="occurredAt"
        label="Due date"
        type="date"
        defaultValue={sv.occurredAt ?? ""}
        error={fe.occurredAt}
      />
      <StandardFormTextarea
        name="body"
        label="Details"
        rows={3}
        placeholder="Details…"
        defaultValue={sv.body ?? ""}
        error={fe.body}
      />
      <StandardFormErrorBanner message={!state.ok ? state.error : undefined} />
      <Submit pending={pending} label="Add task" />
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
      {pending ? "Saving…" : label}
    </button>
  );
}
