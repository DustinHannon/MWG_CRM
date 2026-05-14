import { randomBytes } from "node:crypto";

/**
 * E2E_RUN_ID tags every test-created record so cleanup can remove
 * them by name pattern, and `/admin/audit` can filter audit-log
 * entries from this run via `metadata.e2e_run_id`.
 *
 * If the runner exports E2E_RUN_ID, all specs share it (cleanup uses
 * the same value). Otherwise generate one for this process.
 */
export const E2E_RUN_ID =
  process.env.E2E_RUN_ID ??
  `e2e-${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString("hex")}`;

/** Decorate a name with the run-id tag so cleanup can find it. */
export function tagName(label: string): string {
  return `${label} [E2E-${E2E_RUN_ID}]`;
}

/** Pattern used by cleanup.ts ILIKE matching. */
export const RUN_PATTERN = `%[E2E-${E2E_RUN_ID}]%`;
export const ANY_E2E_PATTERN = `%[E2E-%]%`;
