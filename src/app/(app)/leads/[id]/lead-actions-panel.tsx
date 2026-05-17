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
  mailboxBlocked,
  defaultEmail,
  defaultName,
  defaultTimeZone,
}: {
  leadId: string;
  canSendEmail: boolean;
  /**
   * Cached users.mailbox_kind is a known non-Exchange-Online value.
   * When true the email/meeting tabs show an up-front notice (+ a
   * Send-in-Outlook fallback for email) instead of a form the server
   * would fail closed. The server gate (requireSendableMailbox) is
   * still authoritative — this is proactive UX, not the enforcement.
   */
  mailboxBlocked: boolean;
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
          mailboxBlocked ? (
            <MailboxBlockedNotice channel="email" email={defaultEmail} />
          ) : (
            <div className="flex flex-col gap-3">
              <EmailForm leadId={leadId} defaultEmail={defaultEmail} />
              <SendInOutlookButton email={defaultEmail} />
            </div>
          )
        ) : null}
        {canSendEmail && tab === "meeting" ? (
          mailboxBlocked ? (
            <MailboxBlockedNotice channel="meeting" email={defaultEmail} />
          ) : (
            <MeetingForm
              leadId={leadId}
              defaultEmail={defaultEmail}
              defaultName={defaultName}
              defaultTimeZone={defaultTimeZone}
            />
          )
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

/**
 * mailto: link to the user's own mail client (Outlook for MWG),
 * recipient pre-filled with the lead's email. The working path for
 * on-premises mailboxes that the CRM Graph send cannot use, and a
 * general convenience for everyone. Hidden when the lead has no email.
 */
function SendInOutlookButton({ email }: { email?: string | null }) {
  if (!email) return null;
  return (
    <a
      href={`mailto:${email}`}
      className="self-start rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground/90 transition hover:bg-muted"
    >
      Send in Outlook
    </a>
  );
}

function MailboxBlockedNotice({
  channel,
  email,
}: {
  channel: "email" | "meeting";
  email?: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div
        role="status"
        className="rounded-md border border-[var(--status-lost-fg)]/30 bg-[var(--status-lost-bg)] px-3 py-2 text-sm text-[var(--status-lost-fg)]"
      >
        {channel === "email"
          ? "Your mailbox isn't Exchange Online, so email can't be sent from here. Use Send in Outlook below, or contact MWG IT to migrate."
          : "Your mailbox isn't Exchange Online, so meetings can't be scheduled here. Contact MWG IT to migrate."}
      </div>
      {channel === "email" ? <SendInOutlookButton email={email} /> : null}
    </div>
  );
}
