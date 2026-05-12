/**
 * Phase 29 §7 — Interactive sign-in flow.
 *
 * Opens a headed Playwright browser on the operator's machine,
 * navigates to the D365 tenant, and waits for the operator to
 * complete sign-in + MFA. Once the operator confirms via Enter on
 * the terminal, the resulting cookies/localStorage are persisted to
 * `storage.json` for reuse by the extractor.
 */

import "dotenv/config";
import { chromium } from "playwright";
import * as readline from "node:readline";

function envOrDefault(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

async function waitEnter(prompt: string): Promise<void> {
  console.log(prompt);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  await new Promise<void>((resolve) => {
    rl.once("line", () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const cdUrl = envOrDefault(
    "CD_BASE_URL",
    "https://mwgroup.crm.dynamics.com",
  );
  const storagePath = envOrDefault("STORAGE_STATE_PATH", "storage.json");

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(cdUrl);

  await waitEnter(
    "Sign in, complete MFA, navigate to ClickDimensions → Messaging → Templates.\n" +
      "Then press Enter here to save the auth state.",
  );

  const url = page.url();
  if (!url.includes("crm.dynamics.com")) {
    console.error(
      `Not signed into D365 (current URL: ${url}). Re-run after completing sign-in.`,
    );
    await browser.close();
    process.exit(1);
  }

  await ctx.storageState({ path: storagePath });
  console.log(
    `Saved auth state to ${storagePath}. Reusable for subsequent runs until D365 invalidates the session.`,
  );
  await browser.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
