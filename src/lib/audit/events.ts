/**
 * Central audit-event taxonomy — the single source of truth that
 * controls every audit-log surface (the /admin/audit category filter,
 * the CSV export, and the action-string constants emit sites use).
 *
 * Two halves:
 *
 * 1. {@link AUDIT_EVENTS} — named constants for the generic CRM / auth /
 *    system events that did NOT already have a domain taxonomy. Emit
 *    sites reference these constants instead of bare string literals so
 *    a typo fails typecheck rather than silently fracturing the
 *    forensic trail (same discipline as the domain-specific
 *    `D365_AUDIT_EVENTS` / `MARKETING_AUDIT_EVENTS`, which stay in
 *    their own modules — emit sites import those directly. They are
 *    deliberately NOT re-exported here: `d365/audit-events.ts` is
 *    `server-only` and this module is imported by the client-side
 *    audit filter, so it must stay dependency-free).
 *
 * 2. {@link AUDIT_EVENT_CATEGORIES} — the category catalog the admin
 *    audit list filters by. Category membership is **prefix-based**:
 *    audit actions follow a strict `domain.entity.verb` /
 *    `domain.verb` convention, so a category owns a set of dotted
 *    prefixes rather than an exhaustive hand-maintained action list.
 *    A new event added anywhere in the codebase is automatically
 *    filterable under its category with zero edits here — adding a
 *    genuinely new top-level domain is the only change that touches
 *    this file.
 *
 * This module is intentionally dependency-free (no `server-only`, no
 * drizzle, no db) so the client-side filter component can import the
 * category list directly. SQL translation of a category lives in
 * `audit-cursor.ts` / the export route, not here.
 */

/**
 * Generic (non-marketing, non-D365) audit-event names. Emit sites pass
 * these as the `action` arg to `writeAudit` / `writeSystemAudit`.
 * Existing events keep their established string literals; this set is
 * the events introduced alongside the coverage review plus the
 * high-value lifecycle events that previously had no constant.
 */
export const AUDIT_EVENTS = {
  // — Authentication / session ————————————————————————————————
  /** Successful Entra (Microsoft Entra ID OIDC) interactive sign-in. */
  AUTH_LOGIN_ENTRA: "auth.login.entra",
  /** Successful breakglass (emergency credentials) sign-in. */
  AUTH_LOGIN_BREAKGLASS: "auth.login.breakglass",
  /** User-initiated sign-out (NextAuth signOut event). */
  AUTH_LOGOUT: "auth.logout",
  /**
   * Session force-invalidated mid-flight because the user's
   * `session_version` no longer matches the DB (admin offboard /
   * force-reauth propagated to an active JWT).
   */
  AUTH_SESSION_FORCE_LOGOUT: "auth.session.force_logout",
  /** Disabled-user login attempt (kept as a constant; already emitted). */
  AUTH_LOGIN_DISABLED_ATTEMPT: "auth.login_disabled_attempt",
  /**
   * A breakglass (emergency credentials) sign-in was denied because the
   * per-username attempt limit was exceeded. Security-governance event
   * (per-event, never aggregated) so brute-force lockouts are forensic.
   * System actor — there is no authenticated user on a denied sign-in.
   */
  AUTH_BREAKGLASS_RATE_LIMITED: "auth.breakglass.rate_limited",

  // — User account lifecycle —————————————————————————————————
  /** A user account row was created via Entra just-in-time provisioning. */
  USER_CREATE_JIT: "user.create.jit",
  /**
   * The breakglass admin account was bootstrapped (cold-start seed of
   * the emergency-access user + its permission grant). System actor.
   */
  USER_CREATE_BREAKGLASS: "user.create.breakglass",
  /**
   * The breakglass account's stored permission row was reconciled to
   * grant every permission column (it must always hold all permissions,
   * including any added after it was created). Emitted only when the
   * reconcile actually flipped at least one column. System actor.
   */
  USER_BREAKGLASS_PERMISSIONS_SYNC: "user.breakglass.permissions_sync",

  // — Tags ————————————————————————————————————————————————————
  /** A new tag definition row was created (lib-level entity create). */
  TAG_CREATE: "tag.create",
  /** A lead's full tag set was replaced (delete-all + re-insert). */
  TAG_SET_REPLACED: "tag.set_replaced",

  // — Saved views —————————————————————————————————————————————
  VIEW_UPDATE: "view.update",
  VIEW_DELETE: "view.delete",

  // — D365 import (gaps in the existing taxonomy's emit coverage) ——
  /** Admin edited staged import-record field values before commit. */
  D365_RECORD_EDIT_FIELDS: "d365.import.record.edit_fields",
  /** Admin set the conflict-resolution decision on a staged record. */
  D365_RECORD_SET_CONFLICT_RESOLUTION:
    "d365.import.record.set_conflict_resolution",
  /** A batch was pulled/advanced from D365 for an in-progress run. */
  D365_BATCH_PULL_NEXT: "d365.import.batch.pull_next",

  // — Marketing suppression provenance ————————————————————————
  /**
   * A suppression row was created/updated by an inbound SendGrid
   * webhook (bounce / unsubscribe / group_unsubscribe / spamreport /
   * invalid). Compliance-relevant; system actor.
   */
  MKT_SUPPRESSION_WEBHOOK: "marketing.suppression.webhook",
  /** A campaign recipient transitioned to a terminal compliance state. */
  MKT_RECIPIENT_COMPLIANCE_STATE: "marketing.campaign.recipient_state",

  // — Cron self-audit (delegating crons that previously had none) ——
  SYSTEM_TASKS_DUE_TODAY: "system.tasks_due_today",
  SYSTEM_SAVED_SEARCH_DIGEST: "system.saved_search_digest",
} as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

/** Sentinel actor-email snapshots for system-initiated audit rows. */
export const AUDIT_SYSTEM_ACTORS = {
  CRON: "system@cron",
  BOOTSTRAP: "system@bootstrap",
  WEBHOOK: "system@webhook",
  /**
   * Auth-plane system events with no authenticated user — e.g. a
   * breakglass sign-in denied by the rate limiter (the request never
   * produced a session, so there is no actor to attribute).
   */
  AUTH: "system@auth",
} as const;

export interface AuditEventCategory {
  /** Stable id used as the filter query-param value + DOM id. */
  readonly id: string;
  /** Sentence-case label rendered in the filter dropdown. */
  readonly label: string;
  /**
   * Dotted action prefixes owned by this category. An audit row
   * belongs to the category when its `action` starts with any prefix.
   * Order matters only for display; matching is "any prefix".
   */
  readonly prefixes: readonly string[];
}

/**
 * Category catalog, in display order. Every meaningful top-level audit
 * domain has exactly one home. `access.denied.*` rows are grouped with
 * Users & access (they are authorization-denial forensics). Request
 * telemetry labels (`*.list` / `*.get` passed to `withApi`) never reach
 * `audit_log`, so they intentionally have no category.
 */
export const AUDIT_EVENT_CATEGORIES: readonly AuditEventCategory[] = [
  {
    id: "leads",
    label: "Leads & conversion",
    prefixes: ["lead.", "leads.import"],
  },
  { id: "accounts", label: "Accounts", prefixes: ["account."] },
  { id: "contacts", label: "Contacts", prefixes: ["contact."] },
  {
    id: "opportunities",
    label: "Opportunities",
    prefixes: ["opportunity."],
  },
  { id: "tasks", label: "Tasks", prefixes: ["task.", "task_view."] },
  {
    id: "activities",
    label: "Activities & notes",
    prefixes: ["activity."],
  },
  { id: "tags", label: "Tags", prefixes: ["tag."] },
  { id: "views", label: "Saved views", prefixes: ["view."] },
  {
    id: "users-access",
    label: "Users & access",
    prefixes: ["user.", "user_preferences.", "permissions.", "access.denied."],
  },
  { id: "auth", label: "Authentication", prefixes: ["auth."] },
  { id: "marketing", label: "Marketing", prefixes: ["marketing."] },
  { id: "d365", label: "D365 import", prefixes: ["d365."] },
  {
    id: "reports",
    label: "Reports & saved searches",
    prefixes: ["reports.", "saved_search_subscription."],
  },
  { id: "jobs", label: "Background jobs", prefixes: ["job.", "jobs."] },
  {
    id: "email",
    label: "Email & communications",
    prefixes: ["email.", "graph."],
  },
  {
    id: "data-imports",
    label: "Data import / export",
    prefixes: [
      "import.",
      "data.delete_all",
      "audit_log.export",
      "api_usage_log.export",
    ],
  },
  {
    id: "system",
    label: "System, security & infrastructure",
    prefixes: [
      "system.",
      "csp.",
      "infra.",
      "observability.",
      "geo.",
      "api_health.",
      "api_key.",
      "scoring.",
      "supabase_metrics.",
      "notifications.",
    ],
  },
] as const;

const CATEGORY_BY_ID = new Map(
  AUDIT_EVENT_CATEGORIES.map((c) => [c.id, c] as const),
);

/** Resolve a category by id, or `undefined` for an unknown id. */
export function getAuditCategory(
  id: string | null | undefined,
): AuditEventCategory | undefined {
  if (!id) return undefined;
  return CATEGORY_BY_ID.get(id);
}

/** Lightweight `{ value, label }` options for the filter `<select>`. */
export const AUDIT_CATEGORY_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = AUDIT_EVENT_CATEGORIES.map((c) => ({ value: c.id, label: c.label }));

/**
 * True when `action` belongs to the category. Pure string check; used
 * by tests and any non-SQL consumer (the cursor builds an equivalent
 * SQL predicate from {@link AuditEventCategory.prefixes}).
 */
export function actionInCategory(
  action: string,
  category: AuditEventCategory,
): boolean {
  return category.prefixes.some((p) => action.startsWith(p));
}
