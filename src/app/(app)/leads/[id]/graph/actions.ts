"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { emailSendLog } from "@/db/schema/email-send-log";
import { leads } from "@/db/schema/leads";
import { users } from "@/db/schema/users";
import { writeAudit } from "@/lib/audit";
import {
  getPermissions,
  requireLeadAccess,
  requireSession,
} from "@/lib/auth-helpers";
import {
  ForbiddenError,
  MailboxUnsupportedError,
  NotFoundError,
  ReauthRequiredKnownError,
} from "@/lib/errors";
import { checkMailboxKind } from "@/lib/email/preflight";
import { sendEmailAndTrack } from "@/lib/graph-email";
import { scheduleMeetingAndTrack } from "@/lib/graph-meeting";
import { createNotification } from "@/lib/notifications";
import { ReauthRequiredError } from "@/lib/graph-token";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

// E2E test-gate sentinel. Byte-identical to `E2E_PATTERN` in
// `src/lib/email/send.ts:20` — the delegated lead-email path is
// consistency-exempt from canonical `sendEmailAs` (see the marker in
// `src/lib/graph-email.ts`), so it must replicate the same gate. A shared
// export would require editing `send.ts`/`types.ts` (the canonical owner of
// the regex); when those are touched next, hoist this to a single constant.
const E2E_SENTINEL_PATTERN = /\[E2E-[^\]]+\]/;

/**
 * Fail-closed mailbox gate for the lead Send email / Schedule meeting
 * actions. Reuses the canonical cached detection (checkMailboxKind ->
 * users.mailbox_kind, 24h TTL, app-permission Graph fallback). On a
 * non-Exchange-Online mailbox (on-premises / unlicensed / unverifiable)
 * it audits the block, writes a bell notification to the actor, and
 * throws MailboxUnsupportedError so the action never reaches Graph.
 * Deliberately NOT gated on isGraphAppConfigured(): the requirement is
 * to fail closed, so an unverifiable mailbox blocks rather than
 * silently attempting a delegated send. The client surfaces a
 * bottom-right toast on code === "MAILBOX_UNSUPPORTED"; the bell
 * notification persists the same explanation.
 */
async function requireSendableMailbox(
  userId: string,
  leadId: string,
  channel: "email" | "meeting",
  emailCtx?: { to: string; subject: string },
): Promise<void> {
  const [u] = await db
    .select({
      email: users.email,
      entraOid: users.entraOid,
      mailboxKind: users.mailboxKind,
      mailboxCheckedAt: users.mailboxCheckedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw new NotFoundError("user");

  const preflight = await checkMailboxKind({
    userId,
    entraOid: u.entraOid,
    mailboxKind: u.mailboxKind,
    mailboxCheckedAt: u.mailboxCheckedAt,
  });
  if (preflight.ok) return;

  const message =
    preflight.message ??
    "Your mailbox can't send email. Contact MWG IT.";

  // Preserve the per-attempt forensic row the admin Email failures
  // surface reads (parity with graph-email.ts's blocked_preflight
  // path, which this gate now short-circuits). Email channel only —
  // a blocked meeting never wrote an email_send_log row.
  if (channel === "email" && emailCtx) {
    await db.insert(emailSendLog).values({
      fromUserId: userId,
      fromUserEmailSnapshot: u.email ?? "",
      toEmail: emailCtx.to,
      feature: "lead.email_activity",
      featureRecordId: leadId,
      subject: emailCtx.subject,
      status: "blocked_preflight",
      errorCode: "MAILBOX_NOT_EXCHANGE_ONLINE",
      errorMessage: message,
    });
  }

  await writeAudit({
    actorId: userId,
    action:
      channel === "email"
        ? "graph.email_blocked_mailbox"
        : "graph.meeting_blocked_mailbox",
    targetType: "lead",
    targetId: leadId,
    after: { mailboxKind: preflight.kind },
  });

  await createNotification({
    userId,
    kind: "mailbox_blocked",
    title:
      channel === "email"
        ? "Email not sent — mailbox not supported"
        : "Meeting not scheduled — mailbox not supported",
    body: message,
    link: `/leads/${leadId}`,
  });

  throw new MailboxUnsupportedError(message);
}

const sendEmailSchema = z.object({
  leadId: z.string().uuid(),
  to: z.string().email(),
  subject: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(50_000),
});

export async function sendEmailAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "graph.email_sent" }, async () => {
    const user = await requireSession();
    const perms = await getPermissions(user.id);
    if (!user.isAdmin && !perms.canSendEmail) {
      throw new ForbiddenError("You don't have permission to send emails.");
    }

    const parsed = sendEmailSchema.parse({
      leadId: formData.get("leadId"),
      to: formData.get("to"),
      subject: formData.get("subject"),
      body: formData.get("body"),
    });

    // E2E test-gate: a subject/recipient carrying the [E2E-<runId>] sentinel
    // must NOT issue a real Graph send. Mirror `sendEmailAs` — write a
    // `blocked_e2e` email_send_log row + audit, then short-circuit. Gated
    // before any Graph/DB-mutation work, before requireLeadAccess (cheapest
    // correct placement; matches send.ts gating E2E before preflight).
    if (
      E2E_SENTINEL_PATTERN.test(parsed.subject) ||
      E2E_SENTINEL_PATTERN.test(parsed.to)
    ) {
      await db.insert(emailSendLog).values({
        fromUserId: user.id,
        fromUserEmailSnapshot: user.email,
        toEmail: parsed.to,
        feature: "lead.email_activity",
        featureRecordId: parsed.leadId,
        subject: parsed.subject,
        status: "blocked_e2e",
        errorCode: "E2E_SENTINEL",
        errorMessage:
          "E2E sentinel present in subject or recipient; skipped delivery",
      });
      await writeAudit({
        actorId: user.id,
        action: "graph.email_blocked_e2e",
        targetType: "lead",
        targetId: parsed.leadId,
        after: { to: parsed.to, subject: parsed.subject },
      });
      revalidatePath(`/leads/${parsed.leadId}`);
      return; // ActionResult { ok: true } — parity with sendEmailAs E2E path
    }

    await requireLeadAccess(user, parsed.leadId);

    // Consent enforcement — never trust the client. The UI hides the panel
    // when lead.doNotEmail, but a stale tab or a crafted POST bypasses that.
    // requireLeadAccess only selects ownerId, so re-read the consent flags.
    const [consent] = await db
      .select({
        doNotEmail: leads.doNotEmail,
        doNotContact: leads.doNotContact,
      })
      .from(leads)
      .where(eq(leads.id, parsed.leadId))
      .limit(1);
    if (!consent) {
      throw new NotFoundError("lead");
    }
    if (consent.doNotEmail || consent.doNotContact) {
      await writeAudit({
        actorId: user.id,
        action: "graph.email_blocked_consent",
        targetType: "lead",
        targetId: parsed.leadId,
        after: {
          reason: consent.doNotEmail ? "do_not_email" : "do_not_contact",
          to: parsed.to,
        },
      });
      throw new ForbiddenError(
        "This lead has opted out of email contact. Update the lead's contact preferences to send.",
      );
    }

    // Fail closed if the sender's mailbox is not Exchange Online.
    await requireSendableMailbox(user.id, parsed.leadId, "email", {
      to: parsed.to,
      subject: parsed.subject,
    });

    // Attachments: pull from formData (multiple <File>s under name "attachment").
    const files = formData
      .getAll("attachment")
      .filter((f): f is File => f instanceof File);
    const atts: Array<{
      filename: string;
      contentType: string;
      bytes: Uint8Array;
    }> = [];
    for (const f of files) {
      if (f.size === 0) continue;
      const buf = new Uint8Array(await f.arrayBuffer());
      atts.push({
        filename: f.name,
        contentType: f.type || "application/octet-stream",
        bytes: buf,
      });
    }

    try {
      const { activityId } = await sendEmailAndTrack({
        leadId: parsed.leadId,
        userId: user.id,
        to: parsed.to,
        subject: parsed.subject,
        body: parsed.body,
        attachments: atts,
      });

      await writeAudit({
        actorId: user.id,
        action: "graph.email_sent",
        targetType: "activity",
        targetId: activityId,
        after: { leadId: parsed.leadId, to: parsed.to },
      });

      revalidatePath(`/leads/${parsed.leadId}`);
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        throw new ReauthRequiredKnownError(
          "Your Microsoft session expired. Reconnect to continue sending mail.",
        );
      }
      throw err;
    }
  });
}

const scheduleMeetingSchema = z.object({
  leadId: z.string().uuid(),
  attendeeEmail: z.string().email(),
  attendeeName: z.string().trim().max(200).optional(),
  subject: z.string().trim().min(1).max(240),
  body: z.string().trim().max(20_000).optional(),
  startIso: z.string().min(1),
  endIso: z.string().min(1),
  timeZone: z.string().min(1).max(80),
  location: z.string().trim().max(240).optional(),
});

export async function scheduleMeetingAction(
  formData: FormData,
): Promise<ActionResult> {
  return withErrorBoundary({ action: "graph.meeting_scheduled" }, async () => {
    const user = await requireSession();

    const parsed = scheduleMeetingSchema.parse({
      leadId: formData.get("leadId"),
      attendeeEmail: formData.get("attendeeEmail"),
      attendeeName: formData.get("attendeeName") || undefined,
      subject: formData.get("subject"),
      body: formData.get("body") || undefined,
      startIso: formData.get("startIso"),
      endIso: formData.get("endIso"),
      timeZone: formData.get("timeZone"),
      location: formData.get("location") || undefined,
    });

    await requireLeadAccess(user, parsed.leadId);

    // Fail closed if the organiser's mailbox is not Exchange Online.
    await requireSendableMailbox(user.id, parsed.leadId, "meeting");

    try {
      const { activityId } = await scheduleMeetingAndTrack({
        leadId: parsed.leadId,
        userId: user.id,
        attendeeEmail: parsed.attendeeEmail,
        attendeeName: parsed.attendeeName,
        subject: parsed.subject,
        body: parsed.body,
        startIso: parsed.startIso,
        endIso: parsed.endIso,
        timeZone: parsed.timeZone,
        location: parsed.location,
      });

      await writeAudit({
        actorId: user.id,
        action: "graph.meeting_scheduled",
        targetType: "activity",
        targetId: activityId,
        after: {
          leadId: parsed.leadId,
          attendee: parsed.attendeeEmail,
          startIso: parsed.startIso,
        },
      });

      revalidatePath(`/leads/${parsed.leadId}`);
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        throw new ReauthRequiredKnownError(
          "Your Microsoft session expired. Reconnect to continue scheduling.",
        );
      }
      throw err;
    }
  });
}
