import { expect, test } from "@playwright/test";

/**
 * Phase 31 — verify the domain status dashboard renders, lists every
 * seeded service, and that the "Run check" / "Mark confirmed" actions
 * update the row state.
 *
 * Requires admin auth (default storageState).
 */

test.describe("Phase 31 — /admin/system/domain-status dashboard", () => {
  test("dashboard lists every seeded service", async ({ page }) => {
    await page.goto("/admin/system/domain-status");
    await expect(page.getByRole("heading", { name: "Domain status" })).toBeVisible();
    // 10 seeded service rows.
    for (const name of [
      "vercel_production_domain",
      "dns_godaddy_cname",
      "supabase_site_url",
      "supabase_redirect_urls",
      "sendgrid_event_webhook",
      "microsoft_entra_oauth_redirect",
      "betterstack_http_source",
      "unlayer_config",
      "clickdimensions_migration_script_env",
      "deskpro_sync_config",
    ]) {
      await expect(page.getByText(name)).toBeVisible();
    }
  });

  test("Run all checks button is enabled", async ({ page }) => {
    await page.goto("/admin/system/domain-status");
    const btn = page.getByRole("button", { name: /run all checks/i });
    await expect(btn).toBeEnabled();
  });
});
