import { expect, test } from "@playwright/test";

/**
 * Phase 27 §7 — Phase 25 §4.2 deferred spec.
 *
 * Verifies the public /api/health endpoint that external uptime
 * monitors poll. Runs un-authenticated because the proxy explicitly
 * exempts /api/health from the session-cookie redirect (see
 * src/proxy.ts PUBLIC_PATH_PREFIXES).
 *
 * Health response shape per src/app/api/health/route.ts:
 *   {
 *     healthy: boolean,
 *     checks: { db, graph, blob },
 *     cachedAt: number,
 *     ttlMs: number
 *   }
 *
 * Status: 200 when every dependency is healthy, 503 when any check
 * fails. Both outcomes are valid responses — the test asserts the
 * envelope is well-formed regardless.
 */

const BASE = "https://crm.morganwhite.com";

test.describe("Phase 25 — /api/health public endpoint", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("GET /api/health returns 200 or 503 with healthy envelope", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/health`);
    // 200 healthy / 503 degraded — both contractually valid.
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty("healthy");
    expect(typeof body.healthy).toBe("boolean");
    expect(body).toHaveProperty("checks");
    expect(body.checks).toHaveProperty("db");
    expect(body.checks).toHaveProperty("graph");
    expect(body.checks).toHaveProperty("blob");
    // Each check carries { ok, durationMs }.
    for (const check of ["db", "graph", "blob"] as const) {
      expect(typeof body.checks[check].ok).toBe("boolean");
      expect(typeof body.checks[check].durationMs).toBe("number");
    }
  });

  test("/api/health does not redirect to /auth/signin", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`, { maxRedirects: 0 });
    expect(res.status()).not.toBe(307);
    expect(res.status()).not.toBe(302);
  });

  test("/api/health emits Cache-Control: no-store", async ({ request }) => {
    const res = await request.get(`${BASE}/api/health`);
    const cc = res.headers()["cache-control"];
    expect(cc).toMatch(/no-store/);
  });
});
