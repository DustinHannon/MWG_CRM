"use client";

import { useState } from "react";
import { EmailForm, MeetingForm } from "./graph/graph-actions";
import {
  CallForm,
  NoteForm,
  TaskForm,
} from "./activities/activity-composer";

type TabKey = "email" | "meeting" | "note" | "call" | "task";

/**
 * Single tabbed action panel for the lead detail page: Send email,
 * Schedule meeting, Note, Log call, Add task. The five forms (and their
 * server actions, fields, validation, error/reauth handling) are kept
 * verbatim from ./graph/graph-actions and ./activities/activity-composer
 * — this is purely the shell that merges what used to be two adjacent
 * tabbed cards into one.
 *
 * Send email / Schedule meeting are gated exactly as before: the page
 * passes `canSendEmail = (perms.canSendEmail || isAdmin) && !doNotEmail`.
 * When false those two triggers and panels are absent (Note / Log call /
 * Add task are always available), and the default tab falls back to
 * "note" so a gated user never lands on a hidden tab.
 */
export function LeadActionsPanel({
  leadId,
  canSendEmail,
  defaultEmail,
  defaultName,
  defaultTimeZone,
}: {
  leadId: string;
  canSendEmail: boolean;
  defaultEmail?: string | null;
  defaultName?: string | null;
  defaultTimeZone: string;
}) {
  const [tab, setTab] = useState<TabKey>(canSendEmail ? "email" : "note");

  return (
    <div className="rounded-2xl border border-border bg-muted/40 p-6 backdrop-blur-xl">
      <div className="flex gap-2">
        {canSendEmail ? (
          <>
            <Pill active={tab === "email"} onClick={() => setTab("email")}>
              Send email
            </Pill>
            <Pill
              active={tab === "meeting"}
              onClick={() => setTab("meeting")}
            >
              Schedule meeting
            </Pill>
          </>
        ) : null}
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
        {canSendEmail && tab === "email" ? (
          <EmailForm leadId={leadId} defaultEmail={defaultEmail} />
        ) : null}
        {canSendEmail && tab === "meeting" ? (
          <MeetingForm
            leadId={leadId}
            defaultEmail={defaultEmail}
            defaultName={defaultName}
            defaultTimeZone={defaultTimeZone}
          />
        ) : null}
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
