/**
 * Phase 22 — test data factories tagged with the E2E run-id.
 *
 * Every record created via these helpers carries the [E2E-${runId}]
 * sentinel so the cleanup pass at end-of-run can scrub them by ILIKE
 * pattern (see tests/e2e/cleanup.ts). DO NOT bypass these helpers
 * when creating production rows from a test.
 */
import type { APIRequestContext } from "@playwright/test";
import { tagName, E2E_RUN_ID } from "../fixtures/run-id";

export const BASE = "https://crm.morganwhite.com";

export interface CreatedLead {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  companyName: string;
}

/**
 * Create a tagged lead via the session-authenticated UI server-action
 * fallback path: POST to /leads/new through the API path that the form
 * action uses. We hit /api/v1/leads with no API key — that returns
 * 401, so this helper is reserved for tests that already hold an
 * authenticated browser context. For session-cookie callers, pass
 * `request` from the page context (`page.request`).
 */
export async function createTaggedLead(
  request: APIRequestContext,
  overrides: Partial<CreatedLead> = {},
): Promise<CreatedLead> {
  const ts = Date.now();
  const firstName = overrides.firstName ?? tagName("Sec");
  const lastName = overrides.lastName ?? `Test${ts}`;
  const email = overrides.email ?? `e2e-sec-${ts}@example.com`;
  const companyName = overrides.companyName ?? tagName(`Co-${ts}`);

  const res = await request.post(`${BASE}/api/v1/leads`, {
    data: { firstName, lastName, email, companyName },
    headers: { "X-E2E-Run-Id": E2E_RUN_ID },
  });
  if (!res.ok()) {
    throw new Error(
      `createTaggedLead failed: ${res.status()} ${await res.text()}`,
    );
  }
  const body = await res.json();
  return {
    id: body.id ?? body.data?.id,
    firstName,
    lastName,
    email,
    companyName,
  };
}

/** Sleep helper for revoke-propagation timing tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
