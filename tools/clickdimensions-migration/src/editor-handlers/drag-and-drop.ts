/**
 * Phase 29 §7 — "Drag and Drop" editor handler.
 *
 * The legacy drag-and-drop editor is the BEE/Beepro embed. It exposes
 * a preview frame whose `<html>` we want for migration.
 *
 * TODO: verify selectors against MWG instance.
 */

import type { Page, FrameLocator } from "playwright";

const IFRAME_SELECTORS: Array<string> = [
  'iframe[id*="bee-preview"]',
  'iframe[id*="bee_preview"]',
  'iframe[id*="dnd-preview"]',
  'iframe[class*="bee-preview"]',
  'iframe[title*="Drag"]',
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

export async function extractDragAndDrop(page: Page): Promise<string> {
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

  return page.evaluate(
    () => document.documentElement.outerHTML ?? "",
  );
}
