import { expect, test } from "@playwright/test";

/**
 * Phase 27 §7 — Phase 26 §6 deferred geo-block spec.
 *
 * The geo-block lives in `src/proxy.ts` and reads the country from
 * `@vercel/functions` `geolocation(req)`. Vercel hydrates that value
 * from the `x-vercel-ip-country` request header at the edge. We can
 * simulate a non-US source by setting that header directly on a
 * Playwright API request — Vercel passes the header through to the
 * proxy unchanged.
 *
 * Two layers of defense:
 *   1. The WAF rule in front (authoritative, blocks at the edge).
 *   2. This middleware fallback (defense-in-depth).
 *
 * This spec exercises layer 2 — the WAF can't block headers we
 * manufacture, so the request reaches the proxy, the proxy sees the
 * spoofed country, and rewrites to /blocked with 403.
 *
 * Caveat: when `VERCEL_ENV` is "preview" or "development" the proxy
 * bypasses geo-block entirely. Production deploys are the only target
 * this spec is meaningful against; running against a preview will
 * surface as a 200 instead of 403 (the test will fail loudly).
 */

const BASE = "https://crm.morganwhite.com";

test.describe("Phase 26 §6 — geo-block fallback", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("GB country header → 403 (rewrite to /blocked)", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/leads`, {
      headers: { "x-vercel-ip-country": "GB" },
      maxRedirects: 0,
    });
    // Proxy rewrites to /blocked with status 403. Rewrite preserves
    // the URL but swaps the response body.
    expect(res.status()).toBe(403);
  });

  test("CN country header → 403", async ({ request }) => {
    const res = await request.get(`${BASE}/leads`, {
      headers: { "x-vercel-ip-country": "CN" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
  });

  test("RU country header on root → 403", async ({ request }) => {
    const res = await request.get(`${BASE}/`, {
      headers: { "x-vercel-ip-country": "RU" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
  });

  test("/blocked itself is publicly reachable (post-block landing)", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/blocked`, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
  });

  test("Missing country header → request proceeds (no block)", async ({
    request,
  }) => {
    // Vercel-internal traffic + IPv6 oddities can produce a missing
    // country. Proxy treats unknown as allow (WAF is authoritative).
    // Asserting this guard so a future refactor doesn't accidentally
    // default-deny and break uptime monitors.
    const res = await request.get(`${BASE}/auth/signin`, {
      maxRedirects: 0,
    });
    expect(res.status()).not.toBe(403);
  });
});
