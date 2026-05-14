import { expect, test } from "@playwright/test";

/**
 * Phase 27 §7 — Phase 25 §6.1/§6.2 deferred CSP spec.
 *
 * Phase 25 §6.1 removed `'unsafe-eval'` from the script-src directive.
 * This spec captures the contract so a regression that re-introduces
 * 'unsafe-eval' (e.g., a future Unlayer integration tweak) is caught
 * before deploy.
 *
 * Strict pieces verified:
 *   - CSP header is present on a top-level page response
 *   - script-src has a nonce + 'strict-dynamic' + NO 'unsafe-eval'
 *   - style-src includes 'unsafe-inline' (pragmatic shadcn/Radix
 *     compromise documented in proxy.ts)
 *   - frame-ancestors 'none' (covers click-jacking)
 *   - report-uri + report-to point at the audited endpoint
 *
 * Runs un-authenticated against /auth/signin because that page is
 * publicly reachable and exercises the same proxy path as any other
 * page. /leads is also covered in security.spec.ts Case 24; this
 * spec focuses on the §6.1 negative assertion (no unsafe-eval).
 */

const BASE = "https://crm.morganwhite.com";

test.describe("Phase 25 — CSP header contract", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("CSP header present on /auth/signin", async ({ request }) => {
    const res = await request.get(`${BASE}/auth/signin`, { maxRedirects: 0 });
    const csp = res.headers()["content-security-policy"];
    expect(csp).toBeTruthy();
  });

  test("CSP script-src has nonce + strict-dynamic, NOT unsafe-eval (Phase 25 §6.1)", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/auth/signin`, { maxRedirects: 0 });
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    expect(csp).toMatch(/script-src[^;]*'strict-dynamic'/);
    // §6.1 regression guard — must NOT contain 'unsafe-eval'.
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
  });

  test("CSP style-src includes 'unsafe-inline' (documented compromise)", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/auth/signin`, { maxRedirects: 0 });
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  test("CSP defines self default-src", async ({ request }) => {
    const res = await request.get(`${BASE}/auth/signin`, { maxRedirects: 0 });
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/default-src 'self'/);
  });

  test("CSP frame-ancestors 'none' + base-uri 'self' + object-src 'none'", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/auth/signin`, { maxRedirects: 0 });
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/object-src 'none'/);
  });

  test("CSP report-uri + report-to point at audited CSP endpoint", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/auth/signin`, { maxRedirects: 0 });
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/report-uri \/api\/v1\/security\/csp-report/);
    expect(csp).toMatch(/report-to csp-endpoint/);
    const reportTo = res.headers()["report-to"];
    expect(reportTo).toBeTruthy();
    expect(reportTo).toContain("csp-endpoint");
  });
});
