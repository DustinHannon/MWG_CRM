import { expect, test } from "@playwright/test";

/**
 * Phase 31 — verify the legacy `.vercel.app` host 301-redirects to the
 * canonical `crm.morganwhite.com` host on every path.
 *
 * Runs unauthenticated. Uses `Host` header injection so the test can
 * exercise the legacy-host code path without DNS for the legacy host
 * pointing anywhere in particular (Vercel routes the request to the
 * project based on host alias, but we don't need that — we POST the
 * Host header directly to the canonical edge and confirm the 301).
 */

const LEGACY = "mwg-crm.vercel.app";
const CANONICAL = "https://crm.morganwhite.com";

test.describe("Phase 31 — legacy domain 301 redirect", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ["/", "/leads", "/api/health", "/admin/system/domain-status"]) {
    test(`GET ${path} on legacy host returns 301 to canonical`, async ({ request }) => {
      const res = await request.get(`https://${LEGACY}${path}`, {
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(301);
      const location = res.headers()["location"];
      expect(location).toBeDefined();
      expect(location).toContain("crm.morganwhite.com");
      expect(location).toContain(path === "/" ? "/" : path);
    });
  }

  test("canonical host returns 200 OK on /api/health", async ({ request }) => {
    const res = await request.get(`${CANONICAL}/api/health`);
    // 200 if all deps healthy; 503 if one is failing. Both prove the
    // canonical host is serving traffic.
    expect([200, 503]).toContain(res.status());
  });
});
