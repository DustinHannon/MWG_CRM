"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { sendEmailAndTrack } from "@/lib/graph-email";
import { scheduleMeetingAndTrack } from "@/lib/graph-meeting";
import { ReauthRequiredError } from "@/lib/graph-token";

export interface GraphActionResult {
  ok: boolean;
  error?: string;
  reauthRequired?: boolean;
  fieldErrors?: Record<string, string[]>;
}

const sendEmailSchema = z.object({
  leadId: z.string().uuid(),
  to: z.string().email(),
  subject: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(50_000),
});

export async function sendEmailAction(
  formData: FormData,
): Promise<GraphActionResult> {
  const user = await requireSession();
  const perms = await getPermissions(user.id);
  if (!user.isAdmin && !perms.canSendEmail) {
    return { ok: false, error: "You don't have permission to send emails." };
  }

  const parsed = sendEmailSchema.safeParse({
    leadId: formData.get("leadId"),
    to: formData.get("to"),
    subject: formData.get("subject"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: "Validation failed.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  // Attachments: pull from formData (multiple <File>s under name "attachment").
  const files = formData.getAll("attachment").filter((f): f is File => f instanceof File);
  const atts: Array<{ filename: string; contentType: string; bytes: Uint8Array }> = [];
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
      leadId: parsed.data.leadId,
      userId: user.id,
      to: parsed.data.to,
      subject: parsed.data.subject,
      body: parsed.data.body,
      attachments: atts,
    });

    await writeAudit({
      actorId: user.id,
      action: "graph.email_sent",
      targetType: "activity",
      targetId: activityId,
      after: { leadId: parsed.data.leadId, to: parsed.data.to },
    });

    revalidatePath(`/leads/${parsed.data.leadId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return {
        ok: false,
        reauthRequired: true,
        error:
          "Your Microsoft session expired. Reconnect to continue sending mail.",
      };
    }
    console.error("[graph] sendEmail error", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Send failed.",
    };
  }
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
): Promise<GraphActionResult> {
  const user = await requireSession();

  const parsed = scheduleMeetingSchema.safeParse({
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
  if (!parsed.success) {
    return {
      ok: false,
      error: "Validation failed.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  try {
    const { activityId } = await scheduleMeetingAndTrack({
      leadId: parsed.data.leadId,
      userId: user.id,
      attendeeEmail: parsed.data.attendeeEmail,
      attendeeName: parsed.data.attendeeName,
      subject: parsed.data.subject,
      body: parsed.data.body,
      startIso: parsed.data.startIso,
      endIso: parsed.data.endIso,
      timeZone: parsed.data.timeZone,
      location: parsed.data.location,
    });

    await writeAudit({
      actorId: user.id,
      action: "graph.meeting_scheduled",
      targetType: "activity",
      targetId: activityId,
      after: {
        leadId: parsed.data.leadId,
        attendee: parsed.data.attendeeEmail,
        startIso: parsed.data.startIso,
      },
    });

    revalidatePath(`/leads/${parsed.data.leadId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return {
        ok: false,
        reauthRequired: true,
        error:
          "Your Microsoft session expired. Reconnect to continue scheduling.",
      };
    }
    console.error("[graph] scheduleMeeting error", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Scheduling failed.",
    };
  }
}
