import "server-only";

/**
 * Phase 23 — D365 import pipeline barrel.
 *
 * Exports the public surface for callers in admin pages, server
 * actions, and (later) cron handlers. Sub-agents A/B/C/D extend this
 * with their entity mappers, fetchers, and commit helpers.
 */
export {
  D365Client,
  getD365Client,
  type D365ODataPage,
  type FetchPageOptions,
} from "./client";
export {
  withD365Retry,
  D365HttpError,
  type D365RetryOptions,
} from "./with-retry";
export { getD365Env, isD365Configured, type D365Env } from "./env";
export {
  D365_AUDIT_EVENTS,
  D365_HALT_REASONS,
  D365_REALTIME_EVENTS,
  type D365AuditEvent,
  type D365HaltReason,
  type D365RealtimeEvent,
} from "./audit-events";
export {
  resolveD365Owner,
  jitProvisionD365Owner,
  type ResolvedOwner,
  type OwnerResolutionSource,
} from "./owner-mapping";
