import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { activities } from "@/db/schema/activities";
import type { D365PhoneCall } from "../types";
import {
  type AttachedActivity,
  type MapResult,
  type ValidationWarning,
  extractCustomFields,
  parseBoolean,
  parseODataDate,
  parseString,
} from "./parsers";

export type NewActivity = InferInsertModel<typeof activities>;

export interface PhoneCallMapContext {
  resolvedUserId: string | null;
  resolvedLeadId?: string | null;
  resolvedAccountId?: string | null;
  resolvedContactId?: string | null;
  resolvedOpportunityId?: string | null;
}

const NATIVE_PHONECALL_FIELDS: ReadonlySet<string> = new Set([
  "activityid",
  "subject",
  "description",
  "scheduledstart",
  "scheduledend",
  "actualstart",
  "actualend",
  "actualdurationminutes",
  "phonenumber",
  "directioncode",
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

export function mapD365Phonecall(
  raw: D365PhoneCall,
  ctx: PhoneCallMapContext,
): MapResult<NewActivity> {
  const warnings: ValidationWarning[] = [];

  const occurredAt = parseODataDate(
    raw.actualend ?? raw.scheduledend ?? raw.createdon,
  );
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  // directioncode: 0=incoming, 1=outgoing per default metadata.
  // Some D365 tenants type it as boolean — parseBoolean handles both.
  const direction: "inbound" | "outbound" = parseBoolean(raw.directioncode)
    ? "outbound"
    : "inbound";

  const durationMinutes: number | null = ((): number | null => {
    const v = (raw as Record<string, unknown>)["actualdurationminutes"];
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  })();

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_PHONECALL_FIELDS,
  );

  // Parent linkage — see annotation.ts for the contract.
  const lookupLogicalName = (raw as Record<string, unknown>)[
    "_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname"
  ];
  const parentEntityType =
    typeof lookupLogicalName === "string" ? lookupLogicalName : null;
  const parentSourceId =
    typeof raw._regardingobjectid_value === "string"
      ? raw._regardingobjectid_value
      : null;

  const mapped: NewActivity & {
    _parentEntityType?: string | null;
    _parentSourceId?: string | null;
  } = {
    leadId: ctx.resolvedLeadId ?? null,
    accountId: ctx.resolvedAccountId ?? null,
    contactId: ctx.resolvedContactId ?? null,
    opportunityId: ctx.resolvedOpportunityId ?? null,
    userId: ctx.resolvedUserId,
    kind: "call",
    direction,
    subject: parseString(raw.subject),
    body: parseString(raw.description),
    occurredAt,
    durationMinutes,
    outcome: null,
    meetingLocation: null,
    meetingAttendees: null,
    graphMessageId: null,
    graphEventId: null,
    graphInternetMessageId: null,
    importedByName: null,
    importDedupKey: `d365-phonecall:${raw.activityid}`,
    createdAt: parseODataDate(raw.createdon),
    updatedAt,
    _parentEntityType: parentEntityType,
    _parentSourceId: parentSourceId,
  };

  const attached: AttachedActivity[] = [
    {
      kind: "call",
      sourceId: raw.activityid,
      sourceEntityType: "phonecall",
      payload: mapped as unknown as Record<string, unknown>,
      warnings,
      customFields,
    },
  ];

  return { mapped, attached, customFields, warnings };
}
