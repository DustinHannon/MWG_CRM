import "server-only";

/**
 * D365 import pipeline barrel.
 *
 * Exports the public surface for callers in admin pages and server
 * actions: the D365 client, retry wrapper, env helpers, audit/halt/
 * realtime taxonomies, and owner resolution.
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
