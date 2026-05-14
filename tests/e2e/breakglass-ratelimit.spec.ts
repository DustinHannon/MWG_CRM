import { test } from "@playwright/test";

/**
 * Phase 27 §7 — Phase 25 §3 deferred breakglass-ratelimit spec.
 *
 * STUB. The breakglass credentials path (Auth.js v5 Credentials
 * provider, gated to ~3 break-glass admins) is rate-limited via the
 * Upstash bucket configured in `src/lib/security/rate-limit.ts`.
 *
 * Asserting the limiter requires hitting /api/auth/callback/credentials
 * with bad creds N+1 times in a window. Each test run would burn a
 * slot in the shared Upstash quota — across all spec invocations the
 * limiter would actually rate-limit the test itself first.
 *
 * Acceptance criteria (deferred):
 *   - After N failed POSTs from the same IP, the (N+1)th returns 429.
 *   - The window expires after the configured TTL.
 *   - audit_log records `auth.breakglass.rate_limited` rows.
 *
 * Manual setup needed:
 *   - Dedicated Upstash test database (not the production one) wired
 *     via PLAYWRIGHT_UPSTASH_TEST_URL / TOKEN so the test can flush
 *     buckets between runs and not affect prod auth flows.
 *   - Tighter limiter config gated to a test header so the
 *     limit-reached state is reachable in <10 attempts.
 */
test.describe.skip("Phase 25 §3 — breakglass rate-limit (deferred — needs Upstash test instance)", () => {
  test("Nth attempt → 429 from same IP", async () => {
    // TODO Phase 28: requires dedicated Upstash test DB.
  });
  test("audit row recorded for rate-limited attempt", async () => {
    // TODO Phase 28.
  });
  test("limiter window expires after TTL", async () => {
    // TODO Phase 28.
  });
});
