import "server-only";

/**
 * Sentinel user id used as the actor FK for system-initiated audit and
 * log writes that don't have a real human actor.
 *
 * Seeded by drizzle/0012_seed_system_sentinel_user.sql with email
 * `system@morganwhite.com` and is_active=false so the row cannot
 * authenticate. Call sites that previously dropped a write on FK miss
 * (`marketing.email_send_log.skipped_no_user` was the canonical
 * symptom) now attribute to this id as the last-resort fallback.
 */
export const SYSTEM_SENTINEL_USER_ID =
  "3aa151da-b500-4463-bccf-2fc3f6c5ef18" as const;

/**
 * Email snapshot value to pair with SYSTEM_SENTINEL_USER_ID when the
 * `*EmailSnapshot` companion column is also required.
 */
export const SYSTEM_SENTINEL_USER_EMAIL = "system@morganwhite.com" as const;
