import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { activities } from "@/db/schema/activities";
import type { D365Appointment } from "../types";
import {
  type AttachedActivity,
  type ChildParentContext,
  type MapResult,
  type ValidationWarning,
  buildChildMetadata,
  extractCustomFields,
  parseODataDate,
  parseOptionalDate,
  parseString,
} from "./parsers";

export type NewActivity = InferInsertModel<typeof activities>;

export interface AppointmentMapContext {
  resolvedUserId: string | null;
  resolvedLeadId?: string | null;
  resolvedAccountId?: string | null;
  resolvedContactId?: string | null;
  resolvedOpportunityId?: string | null;
  /**
   * Explicit ROOT parent context (type + GUID of the root this meeting
   * was stitched under). Drives the `_parentEntityType` /
   * `_parentSourceId` virtuals so commit-batch links to the root's
   * in-memory UUID rather than the unrequested lookuplogicalname.
   */
  parentContext?: ChildParentContext;
}

const NATIVE_APPOINTMENT_FIELDS: ReadonlySet<string> = new Set([
  "activityid",
  "subject",
  "description",
  "scheduledstart",
  "scheduledend",
  "actualstart",
  "actualend",
  "scheduleddurationminutes",
  "actualdurationminutes",
  "location",
  "isalldayevent",
  "_regardingobjectid_value",
  "_ownerid_value",
  "_createdby_value",
  "_modifiedby_value",
  "createdon",
  "modifiedon",
  "statecode",
  "statuscode",
  "prioritycode",
]);

export function mapD365Appointment(
  raw: D365Appointment,
  ctx: AppointmentMapContext,
): MapResult<NewActivity> {
  const warnings: ValidationWarning[] = [];

  // Meeting "occurred at" is the scheduled start (vs phonecall's
  // actualend). For past meetings we get actualstart; future meetings
  // only have scheduledstart.
  const occurredAt = parseODataDate(
    raw.actualstart ?? raw.scheduledstart ?? raw.createdon,
  );
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  const startTime = parseOptionalDate(
    raw.actualstart ?? raw.scheduledstart ?? null,
  );
  const endTime = parseOptionalDate(raw.actualend ?? raw.scheduledend ?? null);

  let durationMinutes: number | null = null;
  const scheduled = (raw as Record<string, unknown>)[
    "scheduleddurationminutes"
  ];
  const actual = (raw as Record<string, unknown>)["actualdurationminutes"];
  const dur = actual ?? scheduled;
  if (dur != null) {
    const n = typeof dur === "number" ? dur : Number(dur);
    if (Number.isFinite(n)) durationMinutes = Math.round(n);
  } else if (startTime && endTime) {
    durationMinutes = Math.round(
      (endTime.getTime() - startTime.getTime()) / 60_000,
    );
    if (durationMinutes < 0) durationMinutes = null;
  }

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_APPOINTMENT_FIELDS,
  );

  // Parent linkage — driven by the ROOT context (the root this meeting
  // was stitched under during pull), NOT the polymorphic
  // `_regardingobjectid_value@…lookuplogicalname` annotation. Falls back
  // to the raw regarding GUID only when no ROOT context is supplied.
  const parentEntityType = ctx.parentContext?.parentEntityType ?? null;
  const parentSourceId =
    ctx.parentContext?.parentSourceId ??
    (typeof raw._regardingobjectid_value === "string"
      ? raw._regardingobjectid_value
      : null);

  const mapped: NewActivity & {
    _parentEntityType?: string | null;
    _parentSourceId?: string | null;
  } = {
    leadId: ctx.resolvedLeadId ?? null,
    accountId: ctx.resolvedAccountId ?? null,
    contactId: ctx.resolvedContactId ?? null,
    opportunityId: ctx.resolvedOpportunityId ?? null,
    userId: ctx.resolvedUserId,
    kind: "meeting",
    direction: null,
    subject: parseString(raw.subject),
    body: parseString(raw.description),
    occurredAt,
    durationMinutes,
    outcome: null,
    meetingLocation: parseString(raw.location),
    meetingAttendees: null, // populated separately from activityparty if expanded.
    graphMessageId: null,
    graphEventId: null,
    graphInternetMessageId: null,
    importedByName: null,
    importDedupKey: `d365-appointment:${raw.activityid}`,
    createdAt: parseODataDate(raw.createdon),
    updatedAt,
    metadata: buildChildMetadata({
      source: {
        isalldayevent: raw.isalldayevent ?? null,
        // Kept even when actualdurationminutes drove the duration column,
        // so the originally-scheduled length is not lost.
        scheduleddurationminutes: scheduled ?? null,
        statecode: raw.statecode ?? null,
        statuscode: raw.statuscode ?? null,
        prioritycode: raw.prioritycode ?? null,
      },
      custom: customFields,
    }),
    _parentEntityType: parentEntityType,
    _parentSourceId: parentSourceId,
  };

  const attached: AttachedActivity[] = [
    {
      kind: "meeting",
      sourceId: raw.activityid,
      sourceEntityType: "appointment",
      payload: mapped as unknown as Record<string, unknown>,
      warnings,
      customFields,
    },
  ];

  return { mapped, attached, customFields, warnings };
}
