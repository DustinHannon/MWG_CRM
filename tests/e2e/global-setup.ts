import { chromium, type FullConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Load .env.test.local so PLAYWRIGHT_LOGIN_* credentials reach the
// Chromium-driven SSO flow without callers having to set them in their
// shell. Zero-dep parser — the file format is `KEY=value` per line,
// matching what `dotenv` accepts, plus optional surrounding quotes.
// Existing process.env values win (caller-set shell env is authoritative).
(function loadEnvTestLocal() {
  const envPath = path.resolve(process.cwd(), ".env.test.local");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
})();

const STATE_PATH = path.join(__dirname, ".auth", "croom.json");
const STATE_TTL_HOURS = 6;

/**
 * Phase 12 — real-Entra global setup.
 *
 * The CRM has no test-bypass route (verified in inventory §6). To get
 * an authenticated session we drive the actual Entra SSO flow once per
 * ~6 hours and persist storage state.
 *
 * Credentials are env-only (.env.test.local + Vercel CI secret); never
 * commit them. The test account is configured in Entra without MFA
 * per the user's direction; this setup fails
 * loudly if MFA appears so a future tightening of conditional access
 * is surfaced rather than silently broken.
 */
export default async function globalSetup(_config: FullConfig) {
  if (fs.existsSync(STATE_PATH)) {
    const ageMs = Date.now() - fs.statSync(STATE_PATH).mtimeMs;
    if (ageMs < STATE_TTL_HOURS * 3600 * 1000) {
      console.log("[auth] reusing cached storage state");
      return;
    }
  }

  const email = process.env.PLAYWRIGHT_LOGIN_EMAIL;
  const password = process.env.PLAYWRIGHT_LOGIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "PLAYWRIGHT_LOGIN_EMAIL and PLAYWRIGHT_LOGIN_PASSWORD must be set " +
        "(see PHASE12-REPORT.md manual-steps section).",
    );
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://crm.morganwhite.com/auth/signin");

  // The signin page exposes a Microsoft / Entra button. Try a few
  // accessible-name variants because the label may evolve.
  await page
    .getByRole("button", {
      name: /sign in with microsoft|continue with sso|microsoft|entra/i,
    })
    .first()
    .click();

  // Microsoft account picker. Skip if already-known user is shown.
  const emailInput = page.getByLabel(/email|sign in|account/i).first();
  await emailInput.fill(email);
  await page.getByRole("button", { name: /next/i }).click();

  // Password page.
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  // "Stay signed in?" prompt is sometimes shown.
  try {
    await page.getByRole("button", { name: /^yes$/i }).click({ timeout: 5000 });
  } catch {
    /* prompt not shown — fine */
  }

  // Defensive: surface MFA loudly so we know the test account hardened.
  const mfaVisible = await page
    .locator(
      "text=/verify your identity|enter code|approve sign[- ]in|use your authenticator/i",
    )
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  if (mfaVisible) {
    throw new Error(
      "MFA prompt appeared. The test account is configured without MFA. " +
        "Confirm in Entra admin center that no Conditional Access policy is " +
        "forcing MFA on this account from the test runner IP. See " +
        "docs/realtime-architecture.md (manual-steps section).",
    );
  }

  await page.waitForURL(/mwg-crm\.vercel\.app\/(leads|home|dashboard|$)/, {
    timeout: 30_000,
  });

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  await context.storageState({ path: STATE_PATH });
  console.log("[auth] storage state saved at", STATE_PATH);

  await browser.close();
}
