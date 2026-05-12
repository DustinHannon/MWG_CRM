import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { tasks } from "@/db/schema/tasks";
import type { D365Task } from "../types";
import {
  type AttachedActivity,
  type MapResult,
  type ValidationWarning,
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

  // Parent linkage — _regardingobjectid_value + its OData lookup
  // logical name annotation. commit-batch resolves to local FK
  // via external_ids and strips before Drizzle insert.
  const lookupLogicalName = (raw as Record<string, unknown>)[
    "_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname"
  ];
  const parentEntityType =
    typeof lookupLogicalName === "string" ? lookupLogicalName : null;
  const parentSourceId =
    typeof raw._regardingobjectid_value === "string"
      ? raw._regardingobjectid_value
      : null;

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
