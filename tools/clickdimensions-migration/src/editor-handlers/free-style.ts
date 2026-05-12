/**
 * Phase 29 §7 — "Free style" editor handler.
 *
 * The Free Style editor renders a WYSIWYG iframe. The actual body
 * HTML lives inside the iframe's <body>. We locate the iframe by
 * common heuristics and read the inner HTML.
 *
 * TODO: verify selectors against MWG instance.
 */

import type { Page, FrameLocator } from "playwright";

const IFRAME_SELECTORS: Array<string> = [
  // The Telerik RadEditor classic chrome.
  'iframe[title*="Editor"]',
  'iframe[id*="ContentIframe"]',
  // CKEditor / TinyMCE pattern.
  "iframe.cke_wysiwyg_frame",
  "iframe.tox-edit-area__iframe",
  // Generic message body iframe.
  'iframe[id*="messagebody"]',
];

async function tryFrame(
  page: Page,
  selector: string,
): Promise<FrameLocator | null> {
  try {
    const locator = page.frameLocator(selector);
    // Heuristic: ensure the body has actual content.
    const bodyCount = await locator.locator("body").count();
    if (bodyCount === 0) return null;
    return locator;
  } catch {
    return null;
  }
}

export async function extractFreeStyle(page: Page): Promise<string> {
  await page.waitForLoadState("domcontentloaded");
  for (const sel of IFRAME_SELECTORS) {
    const frame = await tryFrame(page, sel);
    if (!frame) continue;
    try {
      const html = await frame
        .locator("html")
        .first()
        .evaluate((el: Element) => el.outerHTML);
      if (html && html.length > 0) return html;
    } catch {
      continue;
    }
  }

  // Final fallback: read the host page body.
  return page.evaluate(
    () => document.documentElement.outerHTML ?? "",
  );
}
