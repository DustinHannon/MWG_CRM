"use client";

import { useActionState, useState } from "react";
import {
  addCallAction,
  addNoteAction,
  addTaskAction,
} from "./actions";
import type { ActionResult } from "@/lib/server-action";

const initial: ActionResult = { ok: true };

type Tab = "note" | "call" | "task";

export function ActivityComposer({ leadId }: { leadId: string }) {
  const [tab, setTab] = useState<Tab>("note");

  return (
    <div className="rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
      <div className="flex gap-2">
        <Pill active={tab === "note"} onClick={() => setTab("note")}>
          Note
        </Pill>
        <Pill active={tab === "call"} onClick={() => setTab("call")}>
          Log call
        </Pill>
        <Pill active={tab === "task"} onClick={() => setTab("task")}>
          Add task
        </Pill>
      </div>

      <div className="mt-4">
        {tab === "note" ? <NoteForm leadId={leadId} /> : null}
        {tab === "call" ? <CallForm leadId={leadId} /> : null}
        {tab === "task" ? <TaskForm leadId={leadId} /> : null}
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

function NoteForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(
    async (_p: ActionResult, fd: FormData) => addNoteAction(fd),
    initial,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <textarea
        name="body"
        rows={4}
        required
        placeholder="Write a note about this lead…"
        className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      {!state.ok && state.error ? <ErrorBox text={state.error} /> : null}
      <Submit pending={pending} label="Add note" />
    </form>
  );
}

function CallForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(
    async (_p: ActionResult, fd: FormData) => addCallAction(fd),
    initial,
  );
  return (
    <form action={action} className="grid gap-3 md:grid-cols-2">
      <input type="hidden" name="leadId" value={leadId} />
      <FieldInput name="subject" label="Subject" />
      <FieldSelect
        name="outcome"
        label="Outcome"
        options={["spoke", "left voicemail", "no answer", "scheduled callback", "wrong number"]}
      />
      <FieldInput
        name="durationMinutes"
        label="Duration (min)"
        type="number"
      />
      <FieldInput
        name="occurredAt"
        label="When"
        type="datetime-local"
      />
      <div className="md:col-span-2">
        <textarea
          name="body"
          rows={3}
          placeholder="What was discussed?"
          className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
      </div>
      {!state.ok && state.error ? (
        <div className="md:col-span-2"><ErrorBox text={state.error} /></div>
      ) : null}
      <div className="md:col-span-2">
        <Submit pending={pending} label="Log call" />
      </div>
    </form>
  );
}

function TaskForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(
    async (_p: ActionResult, fd: FormData) => addTaskAction(fd),
    initial,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leadId" value={leadId} />
      <FieldInput name="subject" label="Subject" required />
      <FieldInput name="occurredAt" label="Due / when" type="datetime-local" />
      <textarea
        name="body"
        rows={3}
        placeholder="Details…"
        className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      />
      {!state.ok && state.error ? <ErrorBox text={state.error} /> : null}
      <Submit pending={pending} label="Add task" />
    </form>
  );
}

function FieldInput({
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

function FieldSelect({
  name,
  label,
  options,
}: {
  name: string;
  label: string;
  options: string[];
}) {
  return (
    <label className="block text-xs uppercase tracking-wide text-muted-foreground">
      {label}
      <select
        name={name}
        defaultValue=""
        className="mt-1 block w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
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
      {pending ? "Saving…" : label}
    </button>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-sm text-[var(--status-lost-fg)]"
    >
      {text}
    </div>
  );
}
