"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import {
  getPermissions,
  requireLeadAccess,
  requireSession,
} from "@/lib/auth-helpers";
import { ForbiddenError, ReauthRequiredKnownError } from "@/lib/errors";
import { sendEmailAndTrack } from "@/lib/graph-email";
import { scheduleMeetingAndTrack } from "@/lib/graph-meeting";
import { ReauthRequiredError } from "@/lib/graph-token";
import { withErrorBoundary, type ActionResult } from "@/lib/server-action";

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

    await requireLeadAccess(user, parsed.leadId);

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
