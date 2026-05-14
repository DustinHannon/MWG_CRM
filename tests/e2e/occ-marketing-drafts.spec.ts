import { test, expect } from "./fixtures/auth";
import { tagName, E2E_RUN_ID } from "./fixtures/run-id";

/**
 * Phase 27 §7.2 — OCC test for marketing campaign draft edit.
 *
 * The campaign wizard at /marketing/campaigns/[id]/edit jumps the
 * user to step 3 (schedule + identity fields) when editing an
 * existing draft. Saving in step 3 calls `updateCampaignDraftAction`
 * with the loaded `expectedVersion`. A 409 CONFLICT surfaces in the
 * wizard error banner (not a sonner toast) with the text:
 *
 *   "This campaign was updated by someone else. Reload to see the
 *    latest version."
 *
 * Two browser contexts load the same draft, context A saves first
 * (succeeds), context B saves second (banner conflict).
 *
 * Constraint: requires a `draft` campaign to exist in production.
 * The spec auto-skips if none exist.
 */

test.describe("OCC — marketing campaign draft edit (Phase 27 §4.8)", () => {
  test("two-context concurrent edit on step 3: 2nd save shows wizard error banner", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext({
      storageState: "tests/e2e/.auth/croom.json",
      extraHTTPHeaders: { "X-E2E-Run-Id": E2E_RUN_ID },
    });
    const ctxB = await browser.newContext({
      storageState: "tests/e2e/.auth/croom.json",
      extraHTTPHeaders: { "X-E2E-Run-Id": E2E_RUN_ID },
    });
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    // ── 1. Locate a draft campaign in production. The campaigns
    //       list page surfaces status pills; we walk rows looking
    //       for one rendered as draft. If none exist, self-skip.
    await a.goto("/marketing/campaigns");

    // Strategy: filter by status if a UI control exists; else
    // probe the first few rows for the word "draft" near a link.
    const draftLinks = a
      .locator('a[href^="/marketing/campaigns/"]')
      .filter({ hasText: /./ });

    const linkCount = await draftLinks.count();
    let draftId: string | null = null;
    for (let i = 0; i < Math.min(linkCount, 30); i++) {
      const link = draftLinks.nth(i);
      const href = await link.getAttribute("href");
      if (!href) continue;
      // Skip the index page itself and /new.
      if (href === "/marketing/campaigns" || href.endsWith("/new")) continue;
      // Probe the row for a "draft" status badge or text.
      const row = link.locator("xpath=ancestor::*[self::tr or self::li or self::div][1]");
      const rowText = (await row.innerText().catch(() => "")) ?? "";
      if (/draft/i.test(rowText)) {
        draftId = href.split("/").filter(Boolean).pop() ?? null;
        break;
      }
    }

    if (!draftId) {
      test.skip(
        true,
        "No draft campaigns found in production — OCC draft test cannot run without one.",
      );
      await ctxA.close();
      await ctxB.close();
      return;
    }

    // ── 2. Both contexts load /edit at the same version. Wizard
    //       auto-advances to step 3 when an existing draft is loaded.
    await a.goto(`/marketing/campaigns/${draftId}/edit`);
    await b.goto(`/marketing/campaigns/${draftId}/edit`);

    // The wizard exposes name + fromName + fromEmail + replyTo in
    // step 3. We bump the campaign name (the most visible field).
    const nameA = a.getByLabel(/^name$/i).first();
    const originalName = (await nameA.inputValue()) ?? "";

    // Context A: append tag, save (advance to next step or submit).
    const tagA = tagName("occ-camp-a");
    await nameA.fill(`${originalName} ${tagA}`.slice(0, 195));
    // The wizard's primary forward action; label can be Next / Save /
    // Schedule depending on step. We click the first enabled button
    // that isn't Cancel/Back.
    await a
      .getByRole("button", { name: /next|save|schedule|continue/i })
      .first()
      .click();

    // Give the server action a moment to land.
    await a.waitForTimeout(1500);

    // Context B: change name and save. Must hit the 409 path
    // because context A bumped the version.
    const nameB = b.getByLabel(/^name$/i).first();
    const tagB = tagName("occ-camp-b");
    await nameB.fill(`${originalName} ${tagB}`.slice(0, 195));
    await b
      .getByRole("button", { name: /next|save|schedule|continue/i })
      .first()
      .click();

    // The wizard renders the conflict via its inline error banner
    // (setError in campaign-wizard.tsx). Match the text the
    // component produces.
    await expect(
      b.getByText(/campaign was updated by someone else.*reload/i),
    ).toBeVisible({ timeout: 10_000 });

    // ── 3. Restore: reload context B, set the name back, save.
    await b.reload();
    const nameBafter = b.getByLabel(/^name$/i).first();
    await nameBafter.fill(originalName);
    await b
      .getByRole("button", { name: /next|save|schedule|continue/i })
      .first()
      .click();

    await ctxA.close();
    await ctxB.close();
  });
});
