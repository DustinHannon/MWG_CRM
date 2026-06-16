import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { activities } from "@/db/schema/activities";
import type { D365Email } from "../types";
import {
  type AttachedActivity,
  type ChildParentContext,
  type MapResult,
  type ValidationWarning,
  buildChildMetadata,
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
  /**
   * Explicit ROOT parent context (type + GUID of the root this email
   * was stitched under). Drives the `_parentEntityType` /
   * `_parentSourceId` virtuals so commit-batch links to the root's
   * in-memory UUID rather than the unrequested lookuplogicalname.
   */
  parentContext?: ChildParentContext;
}

const NATIVE_EMAIL_FIELDS: ReadonlySet<string> = new Set([
  "activityid",
  "subject",
  "description",
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

  // D365 email body lives in `description`. (`description_html` is not a
  // real attribute on the activitypointer/email entity in this org — it
  // 400s the $select — so we read the plain description field.)
  const body = parseString(raw.description);

  const messageId = parseString(
    (raw as Record<string, unknown>)["messageid"],
  );

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_EMAIL_FIELDS,
  );

  // Parent linkage — driven by the ROOT context (the root this email was
  // stitched under during pull), NOT the polymorphic
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
    // NOT graph_internet_message_id — that column carries a global partial
    // UNIQUE index for the Microsoft Graph email-sync dedup plane, but D365
    // stores the same internet message id on multiple email activities
    // (forwards, or one message regarding several records), so populating it
    // collides on activities_graph_intl_msg_uniq and aborts the whole root
    // commit. D365 emails dedup by import_dedup_key (activityid); the raw
    // messageid is preserved in metadata below for traceability.
    graphInternetMessageId: null,
    importedByName: parseString(raw.sender),
    importDedupKey: `d365-email:${raw.activityid}`,
    createdAt: parseODataDate(raw.createdon),
    updatedAt,
    metadata: buildChildMetadata({
      source: {
        // Outlook/Exchange internet message id — kept here, NOT in the
        // graph_internet_message_id column (see note above), so it survives
        // for traceability without tripping the Graph-sync UNIQUE index.
        messageid: messageId,
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
