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
const CAMPAIGN_STATUS_VALUES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "failed",
  "cancelled",
] as const;
// SendGrid event types — exact strings as recorded in marketing_email_events.
const SENDGRID_EVENT_TYPES = [
  "processed",
  "delivered",
  "open",
  "click",
  "bounce",
  "dropped",
  "deferred",
  "unsubscribe",
  "spamreport",
  "group_unsubscribe",
  "group_resubscribe",
  "blocked",
] as const;
const EMAIL_SEND_STATUS_VALUES = [
  "queued",
  "sending",
  "sent",
  "failed",
  "blocked_preflight",
  "blocked_e2e",
] as const;

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
  // ----- Phase 21+ marketing entities -----
  marketing_campaign: {
    table: "marketing_campaigns",
    timestampColumn: "updated_at",
    // Marketing data is not per-user-owned; the access layer falls
    // back to admin/canManageMarketing gating on the entity type
    // rather than per-row owner scoping.
    ownerColumn: "created_by_id",
    softDeleteColumn: "is_deleted",
    label: "Email Campaigns",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      { column: "name", label: "Name", kind: "string" },
      {
        column: "status",
        label: "Status",
        kind: "enum",
        values: CAMPAIGN_STATUS_VALUES,
      },
      { column: "template_id", label: "Template", kind: "uuid" },
      { column: "list_id", label: "List", kind: "uuid" },
      { column: "from_email", label: "From email", kind: "string" },
      { column: "from_name", label: "From name", kind: "string" },
      { column: "scheduled_for", label: "Scheduled for", kind: "date" },
      { column: "sent_at", label: "Sent", kind: "date" },
      { column: "total_recipients", label: "Recipients", kind: "number" },
      { column: "total_sent", label: "Sent", kind: "number" },
      { column: "total_delivered", label: "Delivered", kind: "number" },
      { column: "total_opened", label: "Opened", kind: "number" },
      { column: "total_clicked", label: "Clicked", kind: "number" },
      { column: "total_bounced", label: "Bounced", kind: "number" },
      { column: "total_unsubscribed", label: "Unsubscribed", kind: "number" },
      { column: "created_by_id", label: "Created by", kind: "uuid" },
      { column: "created_at", label: "Created", kind: "date" },
      { column: "updated_at", label: "Updated", kind: "date" },
    ],
  },
  marketing_email_event: {
    table: "marketing_email_events",
    timestampColumn: "received_at",
    ownerColumn: "campaign_id",
    // Append-only event log — no soft delete column on this table.
    softDeleteColumn: null,
    label: "Email Events (raw)",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      { column: "email", label: "Recipient email", kind: "string" },
      {
        column: "event_type",
        label: "Event type",
        kind: "enum",
        values: SENDGRID_EVENT_TYPES,
      },
      { column: "event_timestamp", label: "Event time", kind: "date" },
      { column: "received_at", label: "Received", kind: "date" },
      { column: "campaign_id", label: "Campaign", kind: "uuid" },
      { column: "lead_id", label: "Lead", kind: "uuid" },
      { column: "recipient_id", label: "Recipient row", kind: "uuid" },
      { column: "sendgrid_message_id", label: "SendGrid msg id", kind: "string" },
      { column: "url", label: "Click URL", kind: "string" },
      { column: "reason", label: "Bounce/drop reason", kind: "string" },
      { column: "ip_address", label: "IP address", kind: "string" },
      { column: "user_agent", label: "User agent", kind: "string" },
    ],
  },
  email_send_log: {
    table: "email_send_log",
    timestampColumn: "queued_at",
    ownerColumn: "from_user_id",
    // No soft delete; rows are pruned by the retention cron.
    softDeleteColumn: null,
    label: "Transactional Email Log",
    fields: [
      { column: "id", label: "ID", kind: "uuid" },
      { column: "from_user_id", label: "From user", kind: "uuid" },
      { column: "from_user_email_snapshot", label: "From email", kind: "string" },
      { column: "to_email", label: "To email", kind: "string" },
      { column: "to_user_id", label: "To user", kind: "uuid" },
      { column: "feature", label: "Feature", kind: "string" },
      { column: "feature_record_id", label: "Feature record", kind: "string" },
      { column: "subject", label: "Subject", kind: "string" },
      {
        column: "status",
        label: "Status",
        kind: "enum",
        values: EMAIL_SEND_STATUS_VALUES,
      },
      { column: "error_code", label: "Error code", kind: "string" },
      { column: "http_status", label: "HTTP status", kind: "number" },
      { column: "duration_ms", label: "Duration (ms)", kind: "number" },
      { column: "queued_at", label: "Queued", kind: "date" },
      { column: "sent_at", label: "Sent", kind: "date" },
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
