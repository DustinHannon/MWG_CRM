"use client";

import { useMemo } from "react";

interface SafeHtmlPreviewProps {
  html: string;
  /** Optional title for assistive tech. */
  title?: string;
  /** Tailwind class on the wrapper div. */
  className?: string;
}

/**
 * Renders untrusted HTML (e.g. a marketing
 * template's exported HTML, or an inbound webhook payload) inside a
 * sandboxed iframe via `srcDoc`.
 *
 * Sandbox flags:
 * • `allow-same-origin` is OMITTED. The iframe is opaque to the
 * parent and cannot read parent cookies, localStorage, or DOM.
 * • `allow-scripts` is OMITTED. The HTML cannot execute JS at all.
 * • With neither flag, `<base href>`, link clicks, and `<meta refresh>`
 * cannot navigate the parent or open popups; the document is render-only.
 * • The result: a static render-only preview suitable for marketing
 * template HTML, imported D365 email bodies, and any other untrusted content.
 *
 * Beacon note: a `srcDoc` document inherits the embedder's Content-Security-
 * Policy, so a tracking `<img src="https://evil/pixel">` in an email body is
 * blocked by our `img-src` allowlist — CSP inheritance, not the sandbox, is
 * what stops the beacon. Keep that in mind before relaxing the app CSP.
 *
 * If a future caller needs script execution (e.g. to render Unlayer's
 * own preview iframe contents), they should mount the editor's preview
 * directly — NOT loosen the sandbox here.
 *
 * Rationale (by design): untrusted HTML is rendered through this sandboxed
 * iframe rather than `dangerouslySetInnerHTML`. The
 * `mwg-dangerouslysetinnerhtml-marketing` Semgrep rule in `.semgrep/mwg.yml`
 * enforces that on the marketing surface (the marketing app/component dirs,
 * where attacker-controllable template bodies are authored); this component is
 * the canonical safe sink everywhere else.
 */
export function SafeHtmlPreview({
  html,
  title = "Email preview",
  className,
}: SafeHtmlPreviewProps) {
  // D365 / Outlook email bodies arrive as COMPLETE HTML documents
  // (`<!doctype>` / `<html>` carrying their own `<head>` of MSO styles).
  // Wrapping such a document in another `<body>` orphans its head styles and
  // renders it wrong. Detect a full document and use it verbatim; only wrap a
  // bare fragment (marketing-template export, webhook snippet) in the minimal
  // shell so DOCTYPE standards mode and a sane charset still apply.
  const srcDoc = useMemo(() => {
    // `\s` already includes a leading BOM (U+FEFF), so a separate BOM token
    // is unnecessary — leading whitespace/BOM before the doc opener still
    // counts as a full document. `<?xml` covers Word's XML-prolog exports.
    const isFullDocument = /^\s*(?:<\?xml|<!doctype|<html[\s>])/i.test(html);
    if (isFullDocument) return html;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head><body>${html}</body></html>`;
  }, [html]);

  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={srcDoc}
      className={className ?? "h-full w-full rounded border border-border bg-white"}
    />
  );
}
