import { test } from "@playwright/test";

/**
 * Phase 27 §7 — Phase 25 §4.4 deferred Graph-retry spec.
 *
 * STUB. The Microsoft Graph application-token retry logic in
 * `src/lib/email/graph-app-token.ts` retries on 429 + 5xx with
 * exponential backoff. Asserting this requires either:
 *   (a) MSW or fetch-mock at the test boundary intercepting graph
 *       calls and forcing 429 → 200 sequences, OR
 *   (b) A dedicated test tenant in Entra ID where we can throttle
 *       deliberately and observe retries via Graph audit logs.
 *
 * Per CLAUDE.md the production code is never mocked from tests, so
 * (a) is out. (b) requires standing up a separate AAD app — out of
 * scope for cleanup phases.
 *
 * Acceptance criteria (deferred):
 *   - Token call retries up to 3 times on 429.
 *   - Token call retries up to 3 times on 5xx.
 *   - Final 429 surfaces as a typed Graph error, not generic 500.
 *   - Per-attempt log line emitted with attempt count + backoff ms.
 *
 * Manual setup needed:
 *   - Dedicated AAD test app id in env (separate from prod ENTRA_APP_ID).
 *   - PLAYWRIGHT_GRAPH_FORCE_THROTTLE=1 to exercise the throttle.
 */
test.describe.skip("Phase 25 §4.4 — Graph token retry (deferred — needs Graph mock or AAD test tenant)", () => {
  test("token call retries on 429", async () => {
    // TODO Phase 28: needs test AAD tenant.
  });
  test("token call retries on 5xx", async () => {
    // TODO Phase 28.
  });
  test("final 429 surfaces typed error", async () => {
    // TODO Phase 28.
  });
});
