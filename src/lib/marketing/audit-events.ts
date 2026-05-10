/**
 * Phase 21 — Marketing flow audit-event names.
 *
 * Used as the `action` arg to `writeAudit({ action, ... })`. Phase 20
 * already shipped `marketing.security.*` event names for webhook signature
 * failures, replay rejects, and force-unlocks. Phase 21 adds the regular
 * flow events for normal user-driven CRUD.
 *
 * Convention: `marketing.<entity>.<verb>` matching the CRM-wide audit
 * taxonomy (e.g. `lead.update`, `lead.soft_delete`).
 */

export const MARKETING_AUDIT_EVENTS = {
  TEMPLATE_CREATE: "marketing.template.create",
  TEMPLATE_UPDATE: "marketing.template.update",
  TEMPLATE_DELETE: "marketing.template.delete",
  // Phase 24 §6.5.2 — deletion of a template referenced by an active
  // (scheduled / sending) campaign is refused at the action layer.
  // The block is forensic-grade: every attempt audits the campaigns
  // that blocked it.
  TEMPLATE_DELETE_BLOCKED: "marketing.template.delete_blocked",
  TEMPLATE_PUSHED_TO_SENDGRID: "marketing.template.pushed_to_sendgrid",
  TEMPLATE_TEST_SEND: "marketing.template.test_send",
  TEMPLATE_FORCE_UNLOCK: "marketing.template.force_unlock",

  LIST_CREATE: "marketing.list.create",
  LIST_UPDATE: "marketing.list.update",
  LIST_DELETE: "marketing.list.delete",
  // Phase 24 §6.5.2 — list deletion blocked when referenced by an
  // active (scheduled / sending) campaign.
  LIST_DELETE_BLOCKED: "marketing.list.delete_blocked",
  LIST_REFRESH: "marketing.list.refresh",
  LIST_MEMBER_BULK_ADD: "marketing.list.member_bulk_add",

  CAMPAIGN_CREATE: "marketing.campaign.create",
  CAMPAIGN_UPDATE: "marketing.campaign.update",
  CAMPAIGN_SCHEDULE: "marketing.campaign.schedule",
  CAMPAIGN_CANCEL: "marketing.campaign.cancel",
  CAMPAIGN_DELETE: "marketing.campaign.delete",
  CAMPAIGN_SEND_STARTED: "marketing.campaign.send_started",
  CAMPAIGN_SEND_COMPLETED: "marketing.campaign.send_completed",
  CAMPAIGN_SEND_FAILED: "marketing.campaign.send_failed",
  CAMPAIGN_TEST_SEND: "marketing.campaign.test_send",

  SUPPRESSION_ADDED: "marketing.suppression.added",
  SUPPRESSION_REMOVED: "marketing.suppression.removed",
} as const;

export type MarketingAuditEvent =
  (typeof MARKETING_AUDIT_EVENTS)[keyof typeof MARKETING_AUDIT_EVENTS];
