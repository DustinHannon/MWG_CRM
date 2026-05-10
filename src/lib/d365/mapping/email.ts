import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { activities } from "@/db/schema/activities";
import type { D365Email } from "../types";
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

export interface EmailMapContext {
  resolvedUserId: string | null;
  resolvedLeadId?: string | null;
  resolvedAccountId?: string | null;
  resolvedContactId?: string | null;
  resolvedOpportunityId?: string | null;
}

const NATIVE_EMAIL_FIELDS: ReadonlySet<string> = new Set([
  "activityid",
  "subject",
  "description",
  "description_html",
  "scheduledstart",
  "scheduledend",
  "actualstart",
  "actualend",
  "actualdurationminutes",
  "directioncode",
  "sender",
  "messageid",
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

export function mapD365Email(
  raw: D365Email,
  ctx: EmailMapContext,
): MapResult<NewActivity> {
  const warnings: ValidationWarning[] = [];

  // Email "occurred" = sent/received time (actualend) or fall back to
  // scheduled / created.
  const occurredAt = parseODataDate(
    raw.actualend ?? raw.scheduledend ?? raw.createdon,
  );
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  const direction: "inbound" | "outbound" = parseBoolean(raw.directioncode)
    ? "outbound"
    : "inbound";

  // Prefer description_html when present (D365 stores rich body
  // separately in some configurations); fall back to description.
  const body =
    parseString(raw.description_html) ?? parseString(raw.description);

  const messageId = parseString(
    (raw as Record<string, unknown>)["messageid"],
  );

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_EMAIL_FIELDS,
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
    kind: "email",
    direction,
    subject: parseString(raw.subject),
    body,
    occurredAt,
    durationMinutes: null,
    outcome: null,
    meetingLocation: null,
    meetingAttendees: null,
    graphMessageId: null,
    graphEventId: null,
    graphInternetMessageId: messageId,
    importedByName: parseString(raw.sender),
    importDedupKey: `d365-email:${raw.activityid}`,
    createdAt: parseODataDate(raw.createdon),
    updatedAt,
    _parentEntityType: parentEntityType,
    _parentSourceId: parentSourceId,
  };

  const attached: AttachedActivity[] = [
    {
      kind: "email",
      sourceId: raw.activityid,
      sourceEntityType: "email",
      payload: mapped as unknown as Record<string, unknown>,
      warnings,
      customFields,
    },
  ];

  return { mapped, attached, customFields, warnings };
}
