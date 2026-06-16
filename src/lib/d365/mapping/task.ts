import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { tasks } from "@/db/schema/tasks";
import type { D365Task } from "../types";
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
  picklistMapper,
} from "./parsers";

export type NewTask = InferInsertModel<typeof tasks>;

export interface TaskMapContext {
  resolvedAssignedToId: string | null;
  resolvedLeadId?: string | null;
  resolvedAccountId?: string | null;
  resolvedContactId?: string | null;
  resolvedOpportunityId?: string | null;
  resolvedCreatedById?: string | null;
  /**
   * Explicit ROOT parent context — the type/GUID of the root this task
   * was stitched under in `pull-batch`. Drives the `_parentEntityType`
   * / `_parentSourceId` virtuals so commit-batch links the task to the
   * correct in-memory root UUID, instead of trusting the polymorphic
   * `_regardingobjectid_value@…lookuplogicalname` annotation (which is
   * not requested and so unreliable). Optional only for backward
   * compatibility; the ROOT mapper always supplies it.
   */
  parentContext?: ChildParentContext;
}

const NATIVE_TASK_FIELDS: ReadonlySet<string> = new Set([
  "activityid",
  "subject",
  "description",
  "scheduledstart",
  "scheduledend",
  "actualstart",
  "actualend",
  "_regardingobjectid_value",
  "_ownerid_value",
  "_createdby_value",
  "_modifiedby_value",
  "createdon",
  "modifiedon",
  "statecode",
  "statuscode",
  "prioritycode",
  "percentcomplete",
  "category",
]);

/**
 * D365 task `statecode` → mwg-crm `task_status`.
 * 0=Open, 1=Completed, 2=Canceled (default option-set).
 */
const TASK_STATUS_MAP = picklistMapper<
  "open" | "in_progress" | "completed" | "cancelled"
>(
  {
    0: "open",
    1: "completed",
    2: "cancelled",
  },
  "status",
  "open",
);

/**
 * D365 `prioritycode` → mwg-crm `task_priority`.
 * 0=Low, 1=Normal, 2=High (default option-set).
 * "urgent" has no D365 default; never auto-assigned.
 */
const TASK_PRIORITY_MAP = picklistMapper<
  "low" | "normal" | "high" | "urgent"
>(
  {
    0: "low",
    1: "normal",
    2: "high",
  },
  "priority",
  "normal",
);

export function mapD365Task(
  raw: D365Task,
  ctx: TaskMapContext,
): MapResult<NewTask> {
  const warnings: ValidationWarning[] = [];

  const createdAt = parseODataDate(raw.createdon);
  const updatedAt = parseODataDate(raw.modifiedon ?? raw.createdon);

  let title = parseString(raw.subject);
  if (!title) {
    title = "Untitled Task";
    warnings.push({
      field: "title",
      code: "missing_required",
      message: "D365 task has no subject; defaulted to 'Untitled Task'.",
    });
  }

  const statusResult = TASK_STATUS_MAP(raw.statecode ?? null);
  if (statusResult.warning) warnings.push(statusResult.warning);

  const priorityResult = TASK_PRIORITY_MAP(raw.prioritycode ?? null);
  if (priorityResult.warning) warnings.push(priorityResult.warning);

  const dueAt = parseOptionalDate(raw.scheduledend ?? null);
  const completedAt =
    statusResult.value === "completed"
      ? parseOptionalDate(raw.actualend ?? raw.modifiedon ?? null)
      : null;

  const customFields = extractCustomFields(
    raw as unknown as Record<string, unknown>,
    NATIVE_TASK_FIELDS,
  );

  // Parent linkage — driven by the ROOT context (the root this task was
  // stitched under during pull), NOT the polymorphic
  // `_regardingobjectid_value@…lookuplogicalname` annotation (which is
  // not requested). commit-batch reads these `_`-prefixed virtuals to
  // link the task to the root's in-memory local UUID, then strips them
  // before the Drizzle insert. Falls back to the raw regarding GUID
  // only when no ROOT context is supplied (legacy standalone call).
  const parentEntityType = ctx.parentContext?.parentEntityType ?? null;
  const parentSourceId =
    ctx.parentContext?.parentSourceId ??
    (typeof raw._regardingobjectid_value === "string"
      ? raw._regardingobjectid_value
      : null);

  const mapped: NewTask & {
    _parentEntityType?: string | null;
    _parentSourceId?: string | null;
  } = {
    leadId: ctx.resolvedLeadId ?? null,
    accountId: ctx.resolvedAccountId ?? null,
    contactId: ctx.resolvedContactId ?? null,
    opportunityId: ctx.resolvedOpportunityId ?? null,
    title,
    description: parseString(raw.description),
    status: statusResult.value,
    priority: priorityResult.value,
    dueAt,
    completedAt,
    assignedToId: ctx.resolvedAssignedToId,
    createdById: ctx.resolvedCreatedById ?? ctx.resolvedAssignedToId,
    updatedById: ctx.resolvedCreatedById ?? ctx.resolvedAssignedToId,
    createdAt,
    updatedAt,
    metadata: buildChildMetadata({
      source: {
        // statecode already maps to the `status` enum above; keep the
        // finer statuscode plus the otherwise-unmodelled fields.
        percentcomplete: raw.percentcomplete ?? null,
        category: parseString(raw.category),
        statuscode: raw.statuscode ?? null,
      },
      custom: customFields,
    }),
    _parentEntityType: parentEntityType,
    _parentSourceId: parentSourceId,
  };

  const attached: AttachedActivity[] = [
    {
      kind: "task",
      sourceId: raw.activityid,
      sourceEntityType: "task",
      payload: mapped as unknown as Record<string, unknown>,
      warnings,
      customFields,
    },
  ];

  return { mapped, attached, customFields, warnings };
}
