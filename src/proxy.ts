import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 proxy (formerly "middleware"). Two responsibilities:
 *
 *   1. Phase 1/2 — lightweight auth cookie check. If no session cookie
 *      is present, redirect non-public paths to /auth/signin.
 *
 *   2. Phase 3J — generate a per-request CSP nonce, attach it to the
 *      request via `x-nonce` so server components can read it, and set
 *      the strict CSP on the response. This replaces the permissive CSP
 *      that lived in next.config.ts (now removed from there).
 *
 * Auth.js v5's full session decoding requires the Node runtime because
 * our JWT callback queries the DB; doing that here would force a heavy
 * postgres driver into the Edge runtime. So this proxy does only the
 * cookie presence check; full validation happens in server components.
 */

const PUBLIC_PATH_PREFIXES = [
  "/auth/",
  "/api/auth/",
  // Phase 8 (FIX-021) — cron endpoints authenticate via Bearer token
  // (CRON_SECRET) inside the route handler; bypass the session-cookie
  // redirect so a missing/bad bearer returns a clean 401 instead of a
  // 307 redirect to /auth/signin.
  "/api/cron/",
  // Phase 13 — public REST API and its docs. The /api/v1/* routes
  // authenticate via Bearer-token API key (mwg_live_*) inside the
  // route handler; the proxy must NOT redirect missing-cookie
  // requests away. Same goes for the OpenAPI spec endpoint and the
  // /apihelp documentation page (both are deliberately public).
  "/api/v1/",
  "/api/openapi.json",
  "/apihelp",
  // Phase 25 §4.2 — public health-check endpoint. Probes DB + Graph
  // + Blob; external uptime monitors need to reach it without a
  // session cookie. No auth: failures are non-secret; success is
  // non-secret. Rate-limit isn't necessary since the endpoint caches
  // in-process for HEALTH_CHECK_CACHE_TTL_SECONDS (default 30s).
  "/api/health",
  "/_next/",
  "/favicon",
  "/robots.txt",
  "/sitemap.xml",
];

// Auth.js may CHUNK the session cookie when the JWT exceeds ~4KB.
const SESSION_COOKIE_PREFIXES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

function generateNonce(): string {
  // 16 bytes → 22 chars base64url. Fine for CSP nonces.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function buildCspHeader(nonce: string): string {
  // Strict-dynamic: scripts loaded by trusted (nonce-tagged) scripts
  // inherit trust. Required for Next.js's bundle loader pattern.
  //
  // style-src 'unsafe-inline': pragmatic compromise. shadcn/Radix and
  // react-hook-form inject styles at runtime; nonce-tagging every one
  // would require deep framework integration. Documented in
  // docs/architecture/SECURITY-NOTES.md.
  //
  // Phase 19 — Unlayer (react-email-editor) loads its editor JS bundle
  // from editor.unlayer.com and renders the editor inside an iframe
  // (frame-src). The editor calls api.unlayer.com for asset uploads and
  // template gallery. img-src includes *.unlayer.com for stock images
  // and editor previews. SendGrid (api.sendgrid.com) is reached
  // server-to-server only; the connect-src entry stays defensive in
  // case a future admin debug page calls it directly.
  //
  // Phase 25 §6.1 — 'unsafe-eval' removed from script-src. Previously
  // present for Unlayer's editor bundle; the editor itself runs inside
  // an iframe (frame-src https://editor.unlayer.com) so its script
  // context is the unlayer.com origin, not ours — its eval needs do
  // not require our top-document CSP to permit eval. Smoke-tested
  // against the marketing template editor before deploy. If Unlayer
  // regresses, revert this commit; report-uri below will surface the
  // violation in audit_log within minutes.
  //
  // Phase 25 §6.2 — report-uri + report-to point at the audited
  // endpoint. Browsers send violation reports via either the legacy
  // report-uri (Chrome, Firefox) or the Reporting API report-to
  // (Edge, newer Chrome). Both are wired so the audit catches both
  // dialects. The corresponding Report-To response header sits next
  // to Content-Security-Policy below.
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://editor.unlayer.com`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://editor.unlayer.com`,
    "font-src 'self' https://fonts.gstatic.com https://fonts.scalar.com data:",
    "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com https://graph.microsoft.com https://*.unlayer.com",
    "connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com https://*.supabase.co wss://*.supabase.co https://api.unlayer.com https://api.sendgrid.com",
    "frame-src https://editor.unlayer.com",
    "frame-ancestors 'none'",
    "form-action 'self' https://login.microsoftonline.com",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
    "report-uri /api/v1/security/csp-report",
    "report-to csp-endpoint",
  ].join("; ");
}

// Phase 25 §6.2 — the Reporting API's group definition. 12-week
// max_age (10886400 seconds) matches MDN's recommended longevity for
// security-reporting endpoints; the value is informative for the
// browser cache. Reports land at /api/v1/security/csp-report which
// is public (under /api/v1/) and rate-limited per IP.
const REPORT_TO_HEADER = JSON.stringify({
  group: "csp-endpoint",
  max_age: 10886400,
  endpoints: [{ url: "/api/v1/security/csp-report" }],
});

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Auth redirect (skip for public paths).
  const isPublic = PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p));
  if (!isPublic) {
    const hasSessionCookie = req.cookies
      .getAll()
      .some((c) =>
        SESSION_COOKIE_PREFIXES.some(
          (prefix) => c.name === prefix || c.name.startsWith(`${prefix}.`),
        ) && Boolean(c.value),
      );

    if (!hasSessionCookie) {
      const url = req.nextUrl.clone();
      url.pathname = "/auth/signin";
      url.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(url);
    }
  }

  // Phase 3J — mint nonce, attach to request, set CSP on response.
  const nonce = generateNonce();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set("Content-Security-Policy", buildCspHeader(nonce));
  response.headers.set("Report-To", REPORT_TO_HEADER);

  // Phase 20 — additional defense-in-depth response headers. CSP
  // already covers script/style/connect/frame; these cover the bits
  // CSP doesn't:
  //   - COOP `same-origin` isolates the browsing context group so a
  //     window opened by us (or that opens us) can't reach back via
  //     `window.opener` / cross-origin DOM access. Critical when we
  //     later embed Unlayer's editor iframe.
  //   - COEP is intentionally NOT set. `require-corp` would block
  //     cross-origin embeds (Unlayer editor iframe, SendGrid pixels)
  //     unless those origins serve CORP headers. `credentialless`
  //     would force credential-stripped fetches that may break OAuth
  //     callback flows. Revisit when Unlayer compatibility is confirmed.
  //   - Referrer-Policy `strict-origin-when-cross-origin` matches the
  //     modern browser default; setting it explicitly avoids relying
  //     on user-agent defaults.
  //   - Permissions-Policy denies device features the CRM never uses
  //     so a future feature can't accidentally turn them on without an
  //     explicit grant. Camera/microphone/geolocation are obvious; we
  //     also deny payment, usb, midi, magnetometer, gyroscope, and
  //     accelerometer so a marketing template iframe cannot probe
  //     hardware sensors.
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "midi=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
    ].join(", "),
  );

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
