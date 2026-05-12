/**
 * Phase 29 §7 — Editor-type detection + dispatch.
 *
 * Detection strategy (in order):
 *   1. URL hint — CD's open-template page often carries `editorType` in
 *      the querystring or a form-context segment. Cheapest signal.
 *   2. DOM probe — look for known editor-specific elements.
 *   3. Default — `unknown`, fall back to the Custom HTML handler
 *      which captures the page body as a last-resort.
 *
 * TODO: verify URL / DOM probes against MWG instance.
 */

import type { Page } from "playwright";
import type { EditorType } from "../types.js";
import { extractCustomHtml } from "./custom-html.js";
import { extractFreeStyle } from "./free-style.js";
import { extractEmailDesigner } from "./email-designer.js";
import { extractDragAndDrop } from "./drag-and-drop.js";

export async function detectEditorType(page: Page): Promise<EditorType> {
  // 1. URL hint.
  const url = page.url().toLowerCase();
  if (url.includes("editortype=customhtml")) return "custom-html";
  if (url.includes("editortype=freestyle")) return "free-style";
  if (url.includes("editortype=emaildesigner")) return "email-designer";
  if (url.includes("editortype=draganddrop")) return "drag-and-drop";

  // 2. DOM probes — most specific first.
  try {
    if (
      (await page.locator('iframe[id*="bee-preview"]').count()) > 0 ||
      (await page.locator('iframe[class*="bee-preview"]').count()) > 0
    ) {
      return "drag-and-drop";
    }
    if (
      (await page.locator('iframe[id*="emaildesigner"]').count()) > 0 ||
      (await page.locator('[data-role="email-designer-preview"]').count()) > 0
    ) {
      return "email-designer";
    }
    if (
      (await page.locator("iframe.cke_wysiwyg_frame").count()) > 0 ||
      (await page.locator('iframe[id*="messagebody"]').count()) > 0 ||
      (await page.locator("iframe.tox-edit-area__iframe").count()) > 0
    ) {
      return "free-style";
    }
    if (
      (await page.locator(".CodeMirror-code").count()) > 0 ||
      (await page.locator('textarea[name="htmlbody"]').count()) > 0
    ) {
      return "custom-html";
    }
  } catch {
    // probes failing is non-fatal — fall through to unknown.
  }

  return "unknown";
}

export async function extractByEditorType(
  page: Page,
  editorType: EditorType,
): Promise<string> {
  switch (editorType) {
    case "custom-html":
      return extractCustomHtml(page);
    case "free-style":
      return extractFreeStyle(page);
    case "email-designer":
      return extractEmailDesigner(page);
    case "drag-and-drop":
      return extractDragAndDrop(page);
    case "unknown":
    default:
      // Last-resort: try custom-html, which itself falls back to
      // the full document outerHTML.
      return extractCustomHtml(page);
  }
}
