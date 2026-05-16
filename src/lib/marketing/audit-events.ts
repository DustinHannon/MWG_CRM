/**
 * Marketing flow audit-event names.
 *
 * Used as the `action` arg to `writeAudit({ action,... })`.
 * already shipped `marketing.security.*` event names for webhook signature
 * failures, replay rejects, and force-unlocks. adds the regular
 * flow events for normal user-driven CRUD.
 *
 * Convention: `marketing.<entity>.<verb>` matching the CRM-wide audit
 * taxonomy (e.g. `lead.update`, `lead.soft_delete`).
 */

export const MARKETING_AUDIT_EVENTS = {
  TEMPLATE_CREATE: "marketing.template.create",
  TEMPLATE_UPDATE: "marketing.template.update",
  TEMPLATE_DELETE: "marketing.template.delete",
  // deletion of a template referenced by an active
  // (scheduled / sending) campaign is refused at the action layer.
  // The block is forensic-grade: every attempt audits the campaigns
  // that blocked it.
  TEMPLATE_DELETE_BLOCKED: "marketing.template.delete_blocked",
  TEMPLATE_PUSHED_TO_SENDGRID: "marketing.template.pushed_to_sendgrid",
  TEMPLATE_TEST_SEND: "marketing.template.test_send",
  TEMPLATE_FORCE_UNLOCK: "marketing.template.force_unlock",
  // Template visibility scoping.
  // SCOPE_CHANGED: promote (personal → global) or demote (global →
  // personal); creator-only with the demote case also requiring
  // `canMarketingTemplatesEdit`. `after: { from, to }` carries the
  // transition.
  // CLONED: creator copied an existing visible template into a new
  // `scope='personal'` row. `after: { sourceTemplateId, newScope: 'personal' }`.
  TEMPLATE_SCOPE_CHANGED: "marketing.template.scope_changed",
  TEMPLATE_CLONED: "marketing.template.cloned",
  // When a personal template is deleted, any draft
  // campaigns still referencing it have their template_id cleared so
  // the delete can proceed. Each unlinked campaign is audited
  // individually so the forensic trail captures the cascade.
  CAMPAIGN_TEMPLATE_UNLINKED: "marketing.campaign.template_unlinked",

  LIST_CREATE: "marketing.list.create",
  LIST_UPDATE: "marketing.list.update",
  LIST_DELETE: "marketing.list.delete",
  // list deletion blocked when referenced by an
  // active (scheduled / sending) campaign.
  LIST_DELETE_BLOCKED: "marketing.list.delete_blocked",
  LIST_REFRESH: "marketing.list.refresh",
  LIST_MEMBER_BULK_ADD: "marketing.list.member_bulk_add",
  // Static-list member events. Static lists are populated
  // by Excel import (Sub-agent C) and mass-edited from the static-list
  // detail page. Each per-row mutation writes one audit row so the
  // forensic trail stays granular even for bulk operations.
  LIST_MEMBER_ADDED: "marketing.list.member_added",
  LIST_MEMBER_EDITED: "marketing.list.member_edited",
  LIST_MEMBER_REMOVED: "marketing.list.member_removed",
  LIST_BULK_EDITED: "marketing.list.bulk_edited",
  // list import success summary; written by Sub-agent C
  // after a commit. `after: { runId, total, success, failed, skipped }`.
  LIST_IMPORTED: "marketing.list.imported",

  CAMPAIGN_CREATE: "marketing.campaign.create",
  CAMPAIGN_UPDATE: "marketing.campaign.update",
  CAMPAIGN_SCHEDULE: "marketing.campaign.schedule",
  CAMPAIGN_CANCEL: "marketing.campaign.cancel",
  CAMPAIGN_DELETE: "marketing.campaign.delete",
  CAMPAIGN_SEND_ENQUEUED: "marketing.campaign.send_enqueued",
  CAMPAIGN_SEND_STARTED: "marketing.campaign.send_started",
  CAMPAIGN_SEND_COMPLETED: "marketing.campaign.send_completed",
  CAMPAIGN_SEND_FAILED: "marketing.campaign.send_failed",
  CAMPAIGN_TEST_SEND: "marketing.campaign.test_send",
  // Recovery sweep flipped a campaign wedged in `sending` (process
  // killed mid-batch, no catch ran) back to `failed` so it becomes
  // cancellable/cloneable again. Per-campaign (governance/lifecycle
  // event — always per-event, never aggregated).
  CAMPAIGN_RECOVER_STUCK: "marketing.campaign.recover_stuck",

  SUPPRESSION_ADDED: "marketing.suppression.added",
  SUPPRESSION_REMOVED: "marketing.suppression.removed",
  // operator-initiated additions/removals from the
  // admin UI. Distinct from the generic SUPPRESSION_ADDED/REMOVED
  // (which are reserved for system-sourced webhook + cron events)
  // so the audit log can distinguish operator action from automated
  // mirroring.
  SUPPRESSION_MANUALLY_ADDED: "marketing.suppression.manually_added",
  SUPPRESSION_MANUALLY_REMOVED: "marketing.suppression.manually_removed",

  // ClickDimensions template-migration worklist events.
  // Fired both by the receiving API endpoints (extracted/imported/
  // session_expired/run_started/run_completed) and by the admin
  // worklist UI (fallback_manual when an admin chooses to skip a
  // template the extractor couldn't handle).
  MIGRATION_TEMPLATE_EXTRACTED: "marketing.template.migration.extracted",
  MIGRATION_TEMPLATE_IMPORTED: "marketing.template.migration.imported",
  MIGRATION_TEMPLATE_FAILED: "marketing.template.migration.failed",
  MIGRATION_TEMPLATE_FALLBACK_MANUAL:
    "marketing.template.migration.fallback_manual",
  MIGRATION_SESSION_EXPIRED: "marketing.template.migration.session_expired",
  MIGRATION_RUN_STARTED: "marketing.template.migration.run_started",
  MIGRATION_RUN_COMPLETED: "marketing.template.migration.run_completed",
} as const;

export type MarketingAuditEvent =
  (typeof MARKETING_AUDIT_EVENTS)[keyof typeof MARKETING_AUDIT_EVENTS];
