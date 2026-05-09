import { expect, test } from "@playwright/test";

/**
 * Phase 13 — REST API contract tests. These run un-authenticated (no
 * storage-state) because the API has its own Bearer-token auth
 * separate from the session cookie. Each test verifies a single
 * canonical failure path; happy-path tests would require generating a
 * real key, which can be added when an admin-fixture key is wired in.
 */

const BASE = "https://mwg-crm.vercel.app";

test.describe("API contract — error envelopes", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("GET /api/v1/leads with no Authorization header → 401 UNAUTHORIZED", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/v1/leads`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: expect.stringMatching(/Bearer token/i),
      },
    });
  });

  test("GET /api/v1/leads with malformed token → 401 UNAUTHORIZED", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/v1/leads`, {
      headers: { authorization: "Bearer not_a_real_format" },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("GET /api/v1/leads with bogus mwg_live_ token → 401 UNAUTHORIZED", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/v1/leads`, {
      headers: {
        authorization:
          "Bearer mwg_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("POST /api/v1/leads with no auth → 401 UNAUTHORIZED", async ({
    request,
  }) => {
    const res = await request.post(`${BASE}/api/v1/leads`, {
      data: { first_name: "Test" },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("PATCH /api/v1/leads/:id with no auth → 401 UNAUTHORIZED", async ({
    request,
  }) => {
    const res = await request.patch(
      `${BASE}/api/v1/leads/00000000-0000-0000-0000-000000000000`,
      { data: { first_name: "Test" } },
    );
    expect(res.status()).toBe(401);
  });

  test("DELETE /api/v1/leads/:id with no auth → 401 UNAUTHORIZED", async ({
    request,
  }) => {
    const res = await request.delete(
      `${BASE}/api/v1/leads/00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status()).toBe(401);
  });

  test("/api/v1/leads NEVER 307s — proxy allowlist works", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/v1/leads`, {
      maxRedirects: 0,
    });
    expect(res.status()).not.toBe(307);
    expect(res.status()).not.toBe(302);
  });
});

test.describe("OpenAPI spec — public, complete, no PII", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("GET /api/openapi.json returns 200 logged-out", async ({ request }) => {
    const res = await request.get(`${BASE}/api/openapi.json`);
    expect(res.status()).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("MWG CRM API");
  });

  test("OpenAPI spec contains every entity path", async ({ request }) => {
    const res = await request.get(`${BASE}/api/openapi.json`);
    const spec = await res.json();
    const paths = Object.keys(spec.paths ?? {});
    for (const entity of [
      "leads",
      "accounts",
      "contacts",
      "opportunities",
      "tasks",
      "activities",
    ]) {
      expect(paths).toContain(`/${entity}`);
      expect(paths).toContain(`/${entity}/{id}`);
    }
    expect(paths).toContain("/me");
    expect(paths).toContain("/users");
    expect(paths).toContain("/users/{id}");
  });

  test("OpenAPI spec example payloads contain no real customer data", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/api/openapi.json`);
    const text = await res.text();
    // Every example UUID in our schemas is "00000000-..." or "11111111-..."
    // (synthetic). A real Postgres-generated UUID would be non-zeros.
    // Match any UUID, then ensure it's of the synthetic form.
    const uuids = text.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    );
    for (const uuid of uuids ?? []) {
      // Synthetic UUIDs all start with a repeated digit block.
      expect(uuid).toMatch(/^([0-9])\1{7}-/);
    }
    // Only example email domain we ship is example.com.
    const emails = text.match(
      /[\w.+-]+@(?!example\.com|morganwhite\.com)[\w.-]+\.[A-Za-z]+/g,
    );
    expect(emails ?? []).toEqual([]);
  });
});

test.describe("/apihelp public docs", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("/apihelp loads logged-out (no auth wall)", async ({ page }) => {
    const res = await page.goto(`${BASE}/apihelp`);
    expect(res?.status()).toBe(200);
    // Quickstart / branded sections render server-side
    await expect(page.getByRole("heading", { name: /MWG CRM API/i })).toBeVisible();
    await expect(page.getByText(/Authentication/i).first()).toBeVisible();
    await expect(page.getByText(/Rate limits/i).first()).toBeVisible();
  });

  test("/apihelp does not redirect to /auth/signin", async ({ request }) => {
    const res = await request.get(`${BASE}/apihelp`, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
  });
});
