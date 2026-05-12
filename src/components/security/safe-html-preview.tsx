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
 * • The result: a static render-only preview suitable for marketing
 * template HTML and any other untrusted content.
 *
 * If a future caller needs script execution (e.g. to render Unlayer's
 * own preview iframe contents), they should mount the editor's preview
 * directly — NOT loosen the sandbox here.
 *
 * Rationale (by design): we never render untrusted HTML via
 * `dangerouslySetInnerHTML` outside of this single component. The custom
 * Semgrep rule in `.semgrep/mwg.yml` flags any other `dangerouslySetInnerHTML`
 * site as a finding.
 */
export function SafeHtmlPreview({
  html,
  title = "Email preview",
  className,
}: SafeHtmlPreviewProps) {
  // Wrap with a minimal HTML shell so DOCTYPE-based standards mode
  // applies and CSS units behave consistently.
  const srcDoc = useMemo(
    () =>
      `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head><body>${html}</body></html>`,
    [html],
  );

  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={srcDoc}
      className={className ?? "h-full w-full rounded border border-border bg-white"}
    />
  );
}
