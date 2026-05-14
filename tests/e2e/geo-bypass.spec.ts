import { expect, test } from "@playwright/test";

/**
 * Phase 27 §7 — Phase 26 §6 deferred geo-bypass spec.
 *
 * Several paths must remain reachable from any country regardless of
 * the geo-block decision — external uptime monitors, the /blocked
 * landing page itself, the CSP-report sink, and Next.js static files.
 *
 * GEO_BYPASS_PATH_PREFIXES (src/proxy.ts):
 *   /api/health
 *   /blocked
 *   /api/v1/security/csp-report
 *   /_next
 *   /favicon
 *   /robots.txt
 *   /sitemap.xml
 *
 * This spec asserts each path returns a non-403 response even when
 * the spoofed country (`x-vercel-ip-country: GB`) would otherwise
 * trigger a block.
 */

const BASE = "https://crm.morganwhite.com";

test.describe("Phase 26 §6 — geo-bypass paths", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/api/health bypasses geo-block with GB country", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/health`, {
      headers: { "x-vercel-ip-country": "GB" },
      maxRedirects: 0,
    });
    // 200 healthy or 503 degraded — both are valid responses; what
    // matters is that the geo-block did NOT rewrite to /blocked (403).
    expect(res.status()).not.toBe(403);
    expect([200, 503]).toContain(res.status());
  });

  test("/blocked itself reachable with GB country (no redirect loop)", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/blocked`, {
      headers: { "x-vercel-ip-country": "GB" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
  });

  test("/robots.txt bypasses geo-block", async ({ request }) => {
    const res = await request.get(`${BASE}/robots.txt`, {
      headers: { "x-vercel-ip-country": "GB" },
      maxRedirects: 0,
    });
    expect(res.status()).not.toBe(403);
  });

  test("/api/v1/security/csp-report POST bypasses geo-block", async ({
    request,
  }) => {
    // The endpoint accepts the legacy + Reporting API dialects; we
    // post a minimal CSP report body and just assert the proxy let
    // it through (whatever the handler returns, it must NOT be 403
    // due to geo-block).
    const res = await request.post(
      `${BASE}/api/v1/security/csp-report`,
      {
        data: { "csp-report": { "violated-directive": "script-src" } },
        headers: {
          "content-type": "application/csp-report",
          "x-vercel-ip-country": "GB",
        },
      },
    );
    expect(res.status()).not.toBe(403);
  });
});
