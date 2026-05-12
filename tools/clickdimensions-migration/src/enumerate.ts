/**
 * Phase 29 §7 — Enumerate ClickDimensions templates with pagination.
 *
 * Strategy: walk the templates list view in CD UI. The page renders
 * a paginated table; each row exposes a link (or a JS-driven open
 * handler) to the detail page. We parse template GUIDs from those
 * links and pull surrounding columns (name, subject, category,
 * owner, createdon, modifiedon) where available.
 *
 * For best resilience the script reads the SiteMap-style URLs that
 * Dynamics produces for tables — the GUID is part of the
 * `?id=<guid>&pagetype=entityrecord` query.
 *
 * TODO: verify selectors against MWG instance. The page object model
 * differs between CD versions and even between tenants; selectors
 * here are best-guess and will likely need a one-time adjustment.
 */

import type { Page } from "playwright";
import type { TemplateCandidate } from "./types.js";

const GUID_REGEX =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

interface EnumerateOptions {
  /** Optional ceiling on total templates returned (debug / first-runs). */
  limit: number | null;
  /** Max pages to walk before giving up — safety net. */
  maxPages: number;
}

function extractGuidFromHref(href: string): string | null {
  // Patterns to handle:
  //   …pagetype=entityrecord&etn=cdi_emailtemplate&id={GUID}…
  //   …/main.aspx?pagetype=entityrecord&id=GUID…
  //   …/#!/template/GUID
  const m = href.match(GUID_REGEX);
  return m ? m[1]!.toLowerCase() : null;
}

export async function enumerateTemplates(
  page: Page,
  opts: EnumerateOptions,
): Promise<TemplateCandidate[]> {
  const candidates: TemplateCandidate[] = [];
  const seen = new Set<string>();
  const maxPages = opts.maxPages > 0 ? opts.maxPages : 100;

  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    await page.waitForLoadState("domcontentloaded");

    // 1. Try the canonical Dynamics grid pattern first.
    const rows = page.locator(
      'div[role="row"][row-id], tr[data-row-id], a[data-id*="cdi_emailtemplate"]',
    );
    const rowCount = await rows.count();
    if (rowCount > 0) {
      for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i);
        let href: string | null = null;
        try {
          href = await row.getAttribute("href");
        } catch {
          /* not an <a> */
        }
        if (!href) {
          // Try the first nested <a>.
          const inner = row.locator("a").first();
          if ((await inner.count()) > 0) {
            href = await inner.getAttribute("href");
          }
        }
        const guid = href ? extractGuidFromHref(href) : null;
        if (!guid || seen.has(guid)) continue;

        let name = "";
        try {
          name = (await row.innerText()).split("\n")[0]?.trim() ?? "";
        } catch {
          name = "";
        }
        if (!name) name = `Template ${guid.slice(0, 8)}`;

        candidates.push({
          cdTemplateId: guid,
          cdTemplateName: name.slice(0, 500),
          detailUrl: new URL(href!, page.url()).toString(),
        });
        seen.add(guid);

        if (opts.limit !== null && candidates.length >= opts.limit) {
          return candidates;
        }
      }
    }

    // 2. Look for a "next page" affordance. Standard Dynamics pager.
    const nextBtn = page.locator(
      'button[aria-label="Next page"], button[title="Page Next"]',
    );
    if ((await nextBtn.count()) === 0) break;
    const isDisabled = await nextBtn
      .first()
      .evaluate(
        (el: Element) =>
          el.getAttribute("aria-disabled") === "true" ||
          (el as HTMLButtonElement).disabled === true,
      )
      .catch(() => true);
    if (isDisabled) break;
    await nextBtn.first().click();
    // Small settle delay; the grid re-renders.
    await page.waitForTimeout(500);
  }

  return candidates;
}
