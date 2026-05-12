/**
 * Phase 29 §7 — "Email Designer" editor handler.
 *
 * The Email Designer is the newer block-based editor. Like Free Style
 * it renders a preview iframe; unlike Free Style, the source-of-truth
 * is usually a JSON document referenced by `data-template-id` and
 * the iframe is a render of that JSON.
 *
 * For migration purposes the rendered HTML is what we want — the
 * captured row's `marketing_templates` insert wraps it in a placeholder
 * Unlayer design block anyway.
 *
 * TODO: verify selectors against MWG instance.
 */

import type { Page, FrameLocator } from "playwright";

const PREVIEW_IFRAME_SELECTORS: Array<string> = [
  'iframe[id*="emaildesigner"]',
  'iframe[id*="EmailDesigner"]',
  'iframe[title*="Preview"]',
  'iframe[class*="preview"]',
];

async function tryFrame(
  page: Page,
  selector: string,
): Promise<FrameLocator | null> {
  try {
    const locator = page.frameLocator(selector);
    const bodyCount = await locator.locator("body").count();
    if (bodyCount === 0) return null;
    return locator;
  } catch {
    return null;
  }
}

export async function extractEmailDesigner(page: Page): Promise<string> {
  await page.waitForLoadState("domcontentloaded");
  for (const sel of PREVIEW_IFRAME_SELECTORS) {
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

  // Sometimes the designer renders directly into the host page in a
  // labeled container (no iframe). Check for a wrapping element by
  // class or data-attribute.
  const inlineSelectors: Array<string> = [
    '[data-role="email-designer-preview"]',
    "#emaildesigner-preview",
    ".emaildesigner-canvas",
  ];
  for (const sel of inlineSelectors) {
    const handle = page.locator(sel).first();
    if ((await handle.count()) === 0) continue;
    try {
      const html = await handle.evaluate((el: Element) => el.outerHTML);
      if (html && html.length > 0) return html;
    } catch {
      continue;
    }
  }

  return page.evaluate(
    () => document.documentElement.outerHTML ?? "",
  );
}
