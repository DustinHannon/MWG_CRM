import type { ReportEntityType } from "@/db/schema/saved-reports";

/**
 * Phase 11 — report builder field metadata.
 *
 * Each entry maps a report entity type to the columns offered in the
 * builder. Only columns listed here can be selected in `fields`,
 * grouped on, or aggregated. The runtime validates incoming requests
 * against this whitelist (see `lib/reports/access.ts`) so a malicious
 * client can't inject arbitrary column names.
 *
 * `kind` drives the builder UI:
 *   - "string" / "text" — pickable, groupable, count metric
 *   - "enum" — pickable, groupable, count metric
 *   - "number" — pickable, groupable, sum/avg/min/max metric
 *   - "date" — pickable, groupable (truncated to month/week)
 *   - "uuid" — usually a foreign key; pickable, groupable; surfaced
 *     with a label join when possible
 */

export type FieldKind = "string" | "text" | "enum" | "number" | "date" | "uuid";

export interface FieldMeta {
  /** SQL column name on the entity table. */
  column: string;
  /** Human label for the builder UI. */
  label: string;
  kind: FieldKind;
  /** Optional enum values when kind = "enum". */
  values?: readonly string[];
  /** True if this column has the soft-delete column on the same table. */
  filterable?: boolean;
}

export interface EntityMeta {
  /** Database table. */
  table: string;
  /** Column with the per-row timestamp used for "since" comparisons. */
  timestampColumn: string;
  /** Column used for ownership scoping. */
  ownerColumn: string;
  /** is_deleted column or null if the table has no soft delete. */
  softDeleteColumn: string | null;
  /** Display label. */
  label: string;
  fields: readonly FieldMeta[];
}

const LEAD_STATUS_VALUES = [
  "new",
  "contacted",
  "qualified",
  "unqualified",
  "converted",
  "lost",
] as const;
const LEAD_RATING_VALUES = ["hot", "warm", "cold"] as const;
const LEAD_SOURCE_VALUES = [
  "web",
  "referral",
  "event",
  "cold_call",
  "partner",
  "marketing",
  "import",
  "other",
] as const;
const OPP_STAGE_VALUES = [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;
const TASK_STATUS_VALUES = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
] as const;
const TASK_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
const ACTIVITY_KIND_VALUES = ["note", "call", "email", "meeting", "log"] as const;

export const REPORT_ENTITIES: Record<ReportEntityType, EntityMeta> = {
  lead: {
    table: "leads",
    timestampColumn: "updated_at",
    ownerColumn: "owner_id",
    softDeleteColumn: "is_deleted",
    label: "Leads",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      { column: "first_name", label: "First name", kind: "string" },
      { column: "last_name", label: "Last name", kind: "string" },
      { column: "company_name", label: "Company", kind: "string" },
      { column: "email", label: "Email", kind: "string" },
      { column: "phone", label: "Phone", kind: "string" },
      {
        column: "status",
        label: "Status",
        kind: "enum",
        values: LEAD_STATUS_VALUES,
      },
      {
        column: "rating",
        label: "Rating",
        kind: "enum",
        values: LEAD_RATING_VALUES,
      },
      {
        column: "source",
        label: "Source",
        kind: "enum",
        values: LEAD_SOURCE_VALUES,
      },
      { column: "owner_id", label: "Owner", kind: "uuid" },
      { column: "estimated_value", label: "Estimated value", kind: "number" },
      {
        column: "estimated_close_date",
        label: "Estimated close date",
        kind: "date",
      },
      { column: "score", label: "Score", kind: "number" },
      { column: "score_band", label: "Score band", kind: "string" },
      { column: "created_at", label: "Created", kind: "date" },
      { column: "updated_at", label: "Updated", kind: "date" },
      { column: "last_activity_at", label: "Last activity", kind: "date" },
    ],
  },
  account: {
    table: "crm_accounts",
    timestampColumn: "updated_at",
    ownerColumn: "owner_id",
    softDeleteColumn: "is_deleted",
    label: "Accounts",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      { column: "name", label: "Name", kind: "string" },
      { column: "industry", label: "Industry", kind: "string" },
      { column: "city", label: "City", kind: "string" },
      { column: "state", label: "State", kind: "string" },
      { column: "owner_id", label: "Owner", kind: "uuid" },
      { column: "created_at", label: "Created", kind: "date" },
      { column: "updated_at", label: "Updated", kind: "date" },
    ],
  },
  contact: {
    table: "contacts",
    timestampColumn: "updated_at",
    ownerColumn: "owner_id",
    softDeleteColumn: "is_deleted",
    label: "Contacts",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      { column: "first_name", label: "First name", kind: "string" },
      { column: "last_name", label: "Last name", kind: "string" },
      { column: "job_title", label: "Job title", kind: "string" },
      { column: "email", label: "Email", kind: "string" },
      { column: "phone", label: "Phone", kind: "string" },
      { column: "account_id", label: "Account", kind: "uuid" },
      { column: "owner_id", label: "Owner", kind: "uuid" },
      { column: "created_at", label: "Created", kind: "date" },
      { column: "updated_at", label: "Updated", kind: "date" },
    ],
  },
  opportunity: {
    table: "opportunities",
    timestampColumn: "updated_at",
    ownerColumn: "owner_id",
    softDeleteColumn: "is_deleted",
    label: "Opportunities",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      { column: "name", label: "Name", kind: "string" },
      {
        column: "stage",
        label: "Stage",
        kind: "enum",
        values: OPP_STAGE_VALUES,
      },
      { column: "amount", label: "Amount", kind: "number" },
      { column: "probability", label: "Probability", kind: "number" },
      { column: "expected_close_date", label: "Expected close", kind: "date" },
      { column: "account_id", label: "Account", kind: "uuid" },
      { column: "owner_id", label: "Owner", kind: "uuid" },
      { column: "created_at", label: "Created", kind: "date" },
      { column: "updated_at", label: "Updated", kind: "date" },
      { column: "closed_at", label: "Closed", kind: "date" },
    ],
  },
  task: {
    table: "tasks",
    timestampColumn: "updated_at",
    ownerColumn: "assigned_to_id",
    softDeleteColumn: "is_deleted",
    label: "Tasks",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      { column: "title", label: "Title", kind: "string" },
      {
        column: "status",
        label: "Status",
        kind: "enum",
        values: TASK_STATUS_VALUES,
      },
      {
        column: "priority",
        label: "Priority",
        kind: "enum",
        values: TASK_PRIORITY_VALUES,
      },
      { column: "due_at", label: "Due", kind: "date" },
      { column: "completed_at", label: "Completed", kind: "date" },
      { column: "assigned_to_id", label: "Assignee", kind: "uuid" },
      { column: "created_by_id", label: "Created by", kind: "uuid" },
      { column: "lead_id", label: "Lead", kind: "uuid" },
      { column: "account_id", label: "Account", kind: "uuid" },
      { column: "contact_id", label: "Contact", kind: "uuid" },
      { column: "opportunity_id", label: "Opportunity", kind: "uuid" },
      { column: "created_at", label: "Created", kind: "date" },
      { column: "updated_at", label: "Updated", kind: "date" },
    ],
  },
  activity: {
    table: "activities",
    timestampColumn: "updated_at",
    ownerColumn: "user_id",
    softDeleteColumn: "is_deleted",
    label: "Activities",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      {
        column: "kind",
        label: "Kind",
        kind: "enum",
        values: ACTIVITY_KIND_VALUES,
      },
      { column: "subject", label: "Subject", kind: "string" },
      { column: "user_id", label: "User", kind: "uuid" },
      { column: "lead_id", label: "Lead", kind: "uuid" },
      { column: "account_id", label: "Account", kind: "uuid" },
      { column: "contact_id", label: "Contact", kind: "uuid" },
      { column: "opportunity_id", label: "Opportunity", kind: "uuid" },
      { column: "occurred_at", label: "Occurred", kind: "date" },
      { column: "created_at", label: "Created", kind: "date" },
      { column: "updated_at", label: "Updated", kind: "date" },
    ],
  },
};

export function getEntityMeta(entityType: ReportEntityType): EntityMeta {
  return REPORT_ENTITIES[entityType];
}

export function isValidField(
  entityType: ReportEntityType,
  column: string,
): boolean {
  return REPORT_ENTITIES[entityType].fields.some((f) => f.column === column);
}
