import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { activities } from "@/db/schema/activities";
import { leads } from "@/db/schema/leads";
import { eq } from "drizzle-orm";
import { graphFetchAs } from "@/lib/graph-token";

interface CreatedEvent {
  id: string;
  iCalUId?: string;
  subject: string;
  body?: { contentType?: string; content?: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName?: string };
  attendees: Array<{
    emailAddress: { address: string; name?: string };
    type: string;
  }>;
  webLink?: string;
}

export async function scheduleMeetingAndTrack(args: {
  leadId: string;
  userId: string;
  attendeeEmail: string;
  attendeeName?: string;
  subject: string;
  body?: string;
  startIso: string;
  endIso: string;
  timeZone: string;
  location?: string;
}): Promise<{ activityId: string }> {
  const eventBody = {
    subject: args.subject,
    body: { contentType: "Text", content: args.body ?? "" },
    start: { dateTime: args.startIso, timeZone: args.timeZone },
    end: { dateTime: args.endIso, timeZone: args.timeZone },
    location: args.location ? { displayName: args.location } : undefined,
    attendees: [
      {
        emailAddress: {
          address: args.attendeeEmail,
          name: args.attendeeName,
        },
        type: "required",
      },
    ],
    allowNewTimeProposals: true,
  };

  const created = await graphFetchAs<CreatedEvent>(args.userId, "/me/events", {
    method: "POST",
    body: JSON.stringify(eventBody),
  });

  const inserted = await db
    .insert(activities)
    .values({
      leadId: args.leadId,
      userId: args.userId,
      kind: "meeting",
      direction: "outbound",
      subject: created.subject,
      body: created.body?.content ?? args.body ?? null,
      occurredAt: new Date(args.startIso),
      meetingLocation: created.location?.displayName ?? args.location ?? null,
      meetingAttendees: created.attendees.map((a) => ({
        email: a.emailAddress.address,
        name: a.emailAddress.name ?? null,
        response: "none",
      })) as unknown as object,
      graphEventId: created.id,
    })
    .returning({ id: activities.id });

  await db
    .update(leads)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(leads.id, args.leadId));

  return { activityId: inserted[0].id };
}
