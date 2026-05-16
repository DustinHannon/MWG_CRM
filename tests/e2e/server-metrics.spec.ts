import { test } from "@playwright/test";

/**
 * Phase 27 §7 — Phase 26 §5 deferred /admin/server-metrics spec.
 *
 * STUB. Full implementation requires:
 *   1. Better Stack telemetry source containing recent log rows the
 *      page queries (request-id, severity, application).
 *   2. Synthetic log emissions of known shape to assert against
 *      filter chips + the row table + the detail flyout.
 *   3. A `croom` admin session — the page is admin-only.
 *
 * Acceptance criteria (deferred):
 *   - /admin/server-metrics returns 200 for admin.
 *   - Severity filter chips toggle rows in/out.
 *   - Row click opens a detail flyout with structured fields.
 *   - request-id link resolves to /admin/audit?request_id=… and the
 *     filter pre-fills.
 *   - phase26-final-server-metrics.png visual parity.
 *
 * Manual setup needed before un-skipping:
 *   - PLAYWRIGHT_BETTERSTACK_FIXTURE_TOKEN env var.
 *   - Seed script .tmp/seed-server-metrics.ts emitting 50 known events
 *     across 3 severities + 2 request-ids.
 */
test.describe.skip("Phase 26 §5 — /admin/server-metrics (deferred — needs Better Stack fixture)", () => {
  test("severity filter chips toggle rows", async () => {
    // TODO Phase 28: implement once fixture infrastructure exists.
  });
  test("row detail flyout renders structured fields", async () => {
    // TODO Phase 28.
  });
  test("request-id link cross-navigates to /admin/audit pre-filtered", async () => {
    // TODO Phase 28.
  });
});
