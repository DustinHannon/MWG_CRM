import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { activities } from "@/db/schema/activities";
import type { D365Annotation } from "../types";
import {
  type AttachedActivity,
  type ChildParentContext,
  type MapResult,
  type ValidationWarning,
  extractCustomFields,
  parseODataDate,
  parseString,
} from "./parsers";

/**
 * D365 `annotation` → mwg-crm `activities` (kind='note').
 *
 * Annotations always attach to a parent. The ROOT this note was
 * stitched under (by `_objectid_value` + the per-root `objecttypecode`
 * filter in pull-batch) is passed in as `parentContext`; commit-batch
 * links the note to the root's in-memory local UUID at insert time.
 */

export type NewActivity = InferInsertModel<typeof activities>;

export interface AnnotationMapContext {
  resolvedUserId: string | null;
  /** Optional resolved parent IDs (set later when commit time can map them). */
  resolvedLeadId?: string | null;
  resolvedAccountId?: string | null;
  resolvedContactId?: string | null;
  resolvedOpportunityId?: string | null;
  /**
   * Explicit ROOT parent context (type + GUID of the root this note was
   * stitched under). Drives the `_parentEntityType` / `_parentSourceId`
   * virtuals authoritatively — pull-batch already filtered annotations
   * by `objecttypecode eq '<root>'`, so the parent type is known and we
   * never depend on the (unrequested) lookuplogicalname annotation.
   */
  parentContext?: ChildParentContext;
}

const NATIVE_ANNOTATION_FIELDS: ReadonlySet<string> = new Set([
  "annotationid",
  "subject",
  "notetext",
  "filename",
  "documentbody",
  "mimetype",
  "isdocument",
  "objecttypecode",
  "_objectid_value",
  "_ownerid_value",
  "_createdby_value",
  "_modifiedby_value",
  "createdon",
  "modifiedon",
  "statecode",
  "statuscode",
]);

export function mapD365Annotation(
  raw: D365Annotation,
  ctx: AnnotationMapContext,
): MapResult<NewActivity> {
  const warnings: ValidationWarning[] = [];

  const occurredAt = parseODataDate(raw.createdon);
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  // Note body — D365 stores in `notetext`; subject is optional.
  const body = parseString(raw.notetext);
  if (!body && !raw.documentbody) {
    warnings.push({
      field: "body",
      code: "missing_required",
      message: "D365 annotation has neither notetext nor a document body.",
    });
  }

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_ANNOTATION_FIELDS,
  );

  // Parent linkage — driven by the ROOT context (pull-batch filtered
  // annotations by `objecttypecode eq '<root>'`, so the root type is
  // authoritative). commit-batch reads these `_`-prefixed virtuals to
  // link the note to the root's in-memory local UUID, then strips them
  // before the Drizzle insert. Falls back to the raw objecttypecode /
  // _objectid_value only when no ROOT context is supplied.
  const parentEntityType =
    ctx.parentContext?.parentEntityType ??
    (typeof raw.objecttypecode === "string" ? raw.objecttypecode : null);
  const parentSourceId =
    ctx.parentContext?.parentSourceId ??
    (typeof raw._objectid_value === "string" ? raw._objectid_value : null);

  const mapped: NewActivity & {
    _parentEntityType?: string | null;
    _parentSourceId?: string | null;
  } = {
    leadId: ctx.resolvedLeadId ?? null,
    accountId: ctx.resolvedAccountId ?? null,
    contactId: ctx.resolvedContactId ?? null,
    opportunityId: ctx.resolvedOpportunityId ?? null,
    userId: ctx.resolvedUserId,
    kind: "note",
    direction: null,
    subject: parseString(raw.subject),
    body,
    occurredAt,
    durationMinutes: null,
    outcome: null,
    meetingLocation: null,
    meetingAttendees: null,
    graphMessageId: null,
    graphEventId: null,
    graphInternetMessageId: null,
    importedByName: null,
    importDedupKey: `d365-annotation:${raw.annotationid}`,
    createdAt: occurredAt,
    updatedAt,
    _parentEntityType: parentEntityType,
    _parentSourceId: parentSourceId,
  };

  const attached: AttachedActivity[] = [
    {
      kind: "note",
      sourceId: raw.annotationid,
      sourceEntityType: "annotation",
      payload: mapped as unknown as Record<string, unknown>,
      warnings,
      customFields,
    },
  ];

  return { mapped, attached, customFields, warnings };
}
