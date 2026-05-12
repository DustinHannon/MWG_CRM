/**
 * Phase 29 §7 — "Custom HTML" editor handler.
 *
 * The Custom HTML editor in ClickDimensions stores the message body
 * verbatim in a textarea or a hidden form field. The handler reads
 * that DOM node and returns the value.
 *
 * Selectors are best-guess against common CD UI patterns and MUST
 * be verified on the MWG instance during the first dry-run iteration.
 * TODO: verify selectors against MWG instance.
 */

import type { Page } from "playwright";

const CANDIDATE_SELECTORS: Array<string> = [
  // The CodeMirror/Ace embed CD ships in newer versions exposes the
  // raw content via `.CodeMirror-code` or `.ace_content`.
  ".CodeMirror-code",
  ".ace_content",
  // Hidden textarea named `htmlbody` is the classic single-field
  // backing element.
  'textarea[name="htmlbody"]',
  'textarea[id*="htmlbody"]',
  // Some skins use a divcontenteditable.
  'div[contenteditable="true"][data-field="html"]',
];

export async function extractCustomHtml(page: Page): Promise<string> {
  // Wait for any of the candidate selectors to attach. We don't fail
  // if only some attach — the first match wins below.
  await page.waitForLoadState("domcontentloaded");
  for (const sel of CANDIDATE_SELECTORS) {
    const handle = page.locator(sel).first();
    if ((await handle.count()) === 0) continue;
    // Prefer .inputValue() for textareas; fall back to .textContent.
    try {
      const isTextarea =
        (await handle.evaluate(
          (el: Element) => el.tagName.toLowerCase() === "textarea",
        )) === true;
      if (isTextarea) {
        const val = await handle.inputValue();
        if (val && val.trim().length > 0) return val;
      }
      const text = await handle.evaluate((el: Element) => el.textContent ?? "");
      if (text && text.trim().length > 0) return text;
    } catch {
      // Selector matched a stale node; try the next candidate.
      continue;
    }
  }

  // Final fallback — return the document body's outerHTML. This is
  // a defensible default; the worklist UI lets an admin re-extract or
  // skip if it's wrong.
  return page.evaluate(
    () => document.documentElement.outerHTML ?? "",
  );
}
