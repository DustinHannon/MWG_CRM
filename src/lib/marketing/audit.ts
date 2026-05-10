import "server-only";
import { writeAudit } from "@/lib/audit";

/**
 * Phase 19 — Marketing audit event types. Dotted strings consistent with
 * the rest of the audit_log (lead.create, email.send.success, …).
 *
 * Always pass the actor user id, the target id (template/list/campaign),
 * and a small `after` payload describing what changed. NEVER include the
 * raw HTML body or the design JSON — that's what the table itself stores.
 */
export type MarketingAuditAction =
  // Templates
  | "marketing.template.create"
  | "marketing.template.update"
  | "marketing.template.archive"
  | "marketing.template.restore"
  | "marketing.template.delete"
  | "marketing.template.lock_acquire"
  | "marketing.template.lock_release"
  | "marketing.template.lock_force_release"
  // Lists
  | "marketing.list.create"
  | "marketing.list.update"
  | "marketing.list.refresh"
  | "marketing.list.delete"
  // Campaigns
  | "marketing.campaign.create"
  | "marketing.campaign.update"
  | "marketing.campaign.schedule"
  | "marketing.campaign.send_start"
  | "marketing.campaign.send_complete"
  | "marketing.campaign.send_failed"
  | "marketing.campaign.cancel"
  | "marketing.campaign.test_send"
  | "marketing.campaign.delete"
  // Suppressions
  | "marketing.suppression.add"
  | "marketing.suppression.remove"
  | "marketing.suppression.sync"
  // Phase 20 — Security events. webhook.* are emitted by the Signed
  // Event Webhook receiver on every reject/duplicate path. The remaining
  // events (idor, force_unlock, api_key, filter_dsl, rate_limit) become
  // active when their owning surfaces ship in subsequent passes.
  | "marketing.security.webhook.signature_failed"
  | "marketing.security.webhook.replay_rejected"
  | "marketing.security.webhook.duplicate_event"
  | "marketing.security.webhook.body_too_large"
  | "marketing.security.webhook.malformed"
  | "marketing.security.rate_limit.exceeded"
  | "marketing.security.idor.attempt"
  | "marketing.security.lock.force_unlocked"
  | "marketing.security.api_key.invalid"
  | "marketing.security.filter_dsl.validation_failed";

interface MarketingAuditArgs {
  actorId: string;
  actorEmailSnapshot?: string | null;
  action: MarketingAuditAction;
  targetType: "marketing_template" | "marketing_list" | "marketing_campaign" | "marketing_suppression";
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Wrap `writeAudit` with a tighter contract for the marketing surface.
 * Best-effort by design — `writeAudit` already swallows write failures
 * so we don't double-wrap.
 */
export async function auditMarketing(args: MarketingAuditArgs): Promise<void> {
  await writeAudit({
    actorId: args.actorId,
    actorEmailSnapshot: args.actorEmailSnapshot ?? null,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId ?? undefined,
    before: args.before,
    after: args.after,
  });
}
