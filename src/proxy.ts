import { NextResponse, type NextRequest } from "next/server";
import { geolocation } from "@vercel/functions";
import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { writeSystemAudit } from "@/lib/audit";

/**
 * Next.js 16 proxy (formerly "middleware"). Three responsibilities:
 *
 * 1. geo-block requests outside `GEO_ALLOWED_COUNTRIES`
 * (default US, JM, PR). Runs FIRST, before auth/CSP, so a hostile
 * source from a non-allowlisted region never reaches a route
 * handler. WAF rule in front is the primary defense; this is the
 * fallback for traffic that bypasses or precedes WAF eval.
 *
 * 2. /2 — lightweight auth cookie check. If no session cookie
 * is present, redirect non-public paths to /auth/signin.
 *
 * 3. generate a per-request CSP nonce, attach it to the
 * request via `x-nonce` so server components can read it, and set
 * the strict CSP on the response. This replaces the permissive CSP
 * that lived in next.config.ts (now removed from there).
 *
 * Auth.js v5's full session decoding requires the Node runtime because
 * our JWT callback queries the DB; doing that here would force a heavy
 * postgres driver into the Edge runtime. So this proxy does only the
 * cookie presence check; full validation happens in server components.
 *
 * Runtime: Next.js 16 `proxy.ts` runs on the Node.js runtime (Fluid
 * Compute), which is required for `writeSystemAudit` (postgres-js is
 * Node-only) and for `@vercel/functions` `geolocation()`.
 */

// paths that must never be geo-blocked regardless of
// source country. /api/health for external uptime monitors, /blocked
// for the destination page itself, CSP report endpoint so a blocked
// page can still report any CSP violation, plus Next.js static and
// well-known files.
const GEO_BYPASS_PATH_PREFIXES = [
  "/api/health",
  "/blocked",
  "/api/v1/security/csp-report",
  "/_next",
  "/favicon",
  "/robots.txt",
  "/sitemap.xml",
];

// Vercel-internal probes that traverse the proxy from outside the US
// (screenshot service, og-image bots, edge favicon prefetch). Match
// case-insensitively. Brittle by nature — kept minimal so a UA spoofer
// can't bypass the block with a common string.
const GEO_BYPASS_USER_AGENT_PATTERNS: readonly RegExp[] = [
  /vercel-favicon/i,
  /vercel-screenshot/i,
  /vercel-edge-bot/i,
];

function shouldBypassGeoBlock(req: NextRequest): boolean {
  // Preview + local-dev are always bypassed so engineers in non-US
  // regions don't lock themselves out and so `next dev` works.
  if (env.VERCEL_ENV === "preview") return true;
  if (env.VERCEL_ENV === "development") return true;
  if (env.NODE_ENV === "development") return true;

  const { pathname } = req.nextUrl;
  if (GEO_BYPASS_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p))) {
    return true;
  }
  const ua = req.headers.get("user-agent") ?? "";
  if (ua && GEO_BYPASS_USER_AGENT_PATTERNS.some((re) => re.test(ua))) {
    return true;
  }
  return false;
}

function extractCallerIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Edge geo-block check. Returns a 403 rewrite to
 * `/blocked` for non-allowlisted countries; returns `null` to let the
 * proxy continue (allowed country, bypass path, or missing/unknown
 * country which we treat as allow).
 */
async function geoBlockIfDisallowed(
  req: NextRequest,
): Promise<NextResponse | null> {
  if (shouldBypassGeoBlock(req)) return null;

  const { country } = geolocation(req);
  // Vercel can't always resolve country (internal traffic, edge cold
  // path, IPv6 oddities). Allow — the WAF layer is authoritative for
  // production decisions; the proxy is a defense-in-depth fallback.
  if (!country) return null;

  const cc = country.toUpperCase();
  if (env.GEO_ALLOWED_COUNTRIES.includes(cc)) return null;

  // Block. Throttle audit emission to env.GEO_BLOCK_AUDIT_RATE_LIMIT
  // per ip-hash per hour so a bot looping against /blocked can't
  // saturate audit_log. Both the limiter bucket and the audit-row
  // forensic fields use the same hash (no raw IPs in DB rows).
  const ip = extractCallerIp(req);
  const ipHash = sha256Hex(ip);
  try {
    const rl = await rateLimit(
      { kind: "geo_block", principal: ipHash },
      env.GEO_BLOCK_AUDIT_RATE_LIMIT_PER_IP_PER_HOUR,
      3600,
    );
    if (rl.allowed) {
      await writeSystemAudit({
        actorEmailSnapshot: "system@geo-block",
        action: "geo.block.middleware_enforced",
        targetType: "geo_block",
        ipAddress: ip,
        after: {
          country: cc,
          allowed: env.GEO_ALLOWED_COUNTRIES,
          path: req.nextUrl.pathname,
          ipHash,
        },
      });
    }
  } catch (err) {
    // NEVER let an audit write block the 403 — log structured for
    // observability and continue.
    logger.warn("geo.block.audit_emit_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
      country: cc,
    });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/blocked";
  url.search = "";
  return NextResponse.rewrite(url, { status: 403 });
}

/**
 * If the request arrived on the historical `.vercel.app` host, return a
 * 301 redirect to the same path on the canonical host. Emits
 * `infra.domain.legacy_redirect_hit` once per IP-hash per hour. Returns
 * `null` when the host matches the canonical or is unrecognised — the
 * proxy continues normally.
 */
async function redirectFromLegacyHostIfMatched(
  req: NextRequest,
): Promise<NextResponse | null> {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (host !== env.LEGACY_VERCEL_HOST.toLowerCase()) return null;

  const ip = extractCallerIp(req);
  const ipHash = sha256Hex(ip);
  try {
    const rl = await rateLimit(
      { kind: "legacy_domain_redirect", principal: ipHash },
      env.GEO_BLOCK_AUDIT_RATE_LIMIT_PER_IP_PER_HOUR,
      3600,
    );
    if (rl.allowed) {
      await writeSystemAudit({
        actorEmailSnapshot: "system@domain-redirect",
        action: "infra.domain.legacy_redirect_hit",
        targetType: "domain_redirect",
        ipAddress: ip,
        after: {
          legacyHost: env.LEGACY_VERCEL_HOST,
          canonicalHost: env.NEXT_PUBLIC_CANONICAL_HOST,
          path: req.nextUrl.pathname,
          ipHash,
        },
      });
    }
  } catch (err) {
    // Never let an audit write block the redirect — log and continue.
    logger.warn("infra.domain.legacy_redirect_audit_emit_failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  const target = req.nextUrl.clone();
  target.host = env.NEXT_PUBLIC_CANONICAL_HOST;
  target.protocol = "https:";
  target.port = "";
  return NextResponse.redirect(target, 301);
}

const PUBLIC_PATH_PREFIXES = [
  "/auth/",
  "/api/auth/",
  // cron endpoints authenticate via Bearer token
  // (CRON_SECRET) inside the route handler; bypass the session-cookie
  // redirect so a missing/bad bearer returns a clean 401 instead of a
  // 307 redirect to /auth/signin.
  "/api/cron/",
  // public REST API and its docs. The /api/v1/* routes
  // authenticate via Bearer-token API key (mwg_live_*) inside the
  // route handler; the proxy must NOT redirect missing-cookie
  // requests away. Same goes for the OpenAPI spec endpoint and the
  // /apihelp documentation page (both are deliberately public).
  "/api/v1/",
  "/api/openapi.json",
  "/apihelp",
  // public health-check endpoint. Probes DB + Graph
  // + Blob; external uptime monitors need to reach it without a
  // session cookie. No auth: failures are non-secret; success is
  // non-secret. Rate-limit isn't necessary since the endpoint caches
  // in-process for HEALTH_CHECK_CACHE_TTL_SECONDS (default 30s).
  "/api/health",
  // geo-block destination page. Public so an
  // unauthenticated source from a non-allowlisted country sees the
  // 403 page directly instead of being redirected to /auth/signin
  // (which would defeat the block by exposing the auth surface).
  "/blocked",
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
  // Unlayer (react-email-editor) loads its editor JS bundle
  // from editor.unlayer.com and renders the editor inside an iframe
  // (frame-src). The editor calls api.unlayer.com for asset uploads and
  // template gallery. img-src includes *.unlayer.com for stock images
  // and editor previews. SendGrid (api.sendgrid.com) is reached
  // server-to-server only; the connect-src entry stays defensive in
  // case a future admin debug page calls it directly.
  //
  // 'unsafe-eval' removed from script-src. Previously
  // present for Unlayer's editor bundle; the editor itself runs inside
  // an iframe (frame-src https://editor.unlayer.com) so its script
  // context is the unlayer.com origin, not ours — its eval needs do
  // not require our top-document CSP to permit eval. Smoke-tested
  // against the marketing template editor before deploy. If Unlayer
  // regresses, revert this commit; report-uri below will surface the
  // violation in audit_log within minutes.
  //
  // Failure-mode note: if editor.unlayer.com
  // itself goes down or the bundle is blocked, the iframe simply
  // fails to render — there's no CSP violation to report, so our
  // telemetry stays silent. Detection in that scenario must come
  // from synthetic-monitoring or user reports, not the CSP report
  // endpoint. The /marketing/templates/[id]/edit page renders the
  // empty iframe shell but no editor controls.
  //
  // report-uri + report-to point at the audited
  // endpoint. Browsers send violation reports via either the legacy
  // report-uri (Chrome, Firefox) or the Reporting API report-to
  // (Edge, newer Chrome). Both are wired so the audit catches both
  // dialects. The corresponding Report-To response header sits next
  // to Content-Security-Policy below.
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://editor.unlayer.com https://va.vercel-scripts.com`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://editor.unlayer.com`,
    "font-src 'self' https://fonts.gstatic.com https://fonts.scalar.com data:",
    "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com https://graph.microsoft.com https://*.unlayer.com",
    "connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com https://*.supabase.co wss://*.supabase.co https://api.unlayer.com https://api.sendgrid.com https://va.vercel-scripts.com https://vitals.vercel-analytics.com",
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

// the Reporting API's group definition. 12-week
// max_age (10886400 seconds) matches MDN's recommended longevity for
// security-reporting endpoints; the value is informative for the
// browser cache. Reports land at /api/v1/security/csp-report which
// is public (under /api/v1/) and rate-limited per IP.
const REPORT_TO_HEADER = JSON.stringify({
  group: "csp-endpoint",
  max_age: 10886400,
  endpoints: [{ url: "/api/v1/security/csp-report" }],
});

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Legacy domain 301. Any request that arrived at the
  // historical `.vercel.app` hostname is permanently redirected to the
  // canonical host on the same path. Audit emission throttled per IP
  // hash per hour (reusing GEO_BLOCK_AUDIT_RATE_LIMIT_PER_IP_PER_HOUR
  // since this is the same defense-in-depth class of event) so a bot
  // chasing redirects can't flood audit_log. Runs BEFORE geo-block so
  // the redirect target carries through the same allowlist evaluation
  // on the canonical host.
  const legacyRedirect = await redirectFromLegacyHostIfMatched(req);
  if (legacyRedirect) return legacyRedirect;

  // geo-block FIRST. A 403 for a non-allowlisted source
  // is more important than anything else this proxy does.
  const blocked = await geoBlockIfDisallowed(req);
  if (blocked) return blocked;

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

  // mint nonce, attach to request, set CSP on response.
  const nonce = generateNonce();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set("Content-Security-Policy", buildCspHeader(nonce));
  response.headers.set("Report-To", REPORT_TO_HEADER);

  // additional defense-in-depth response headers. CSP
  // already covers script/style/connect/frame; these cover the bits
  // CSP doesn't:
  // COOP `same-origin` isolates the browsing context group so a
  // window opened by us (or that opens us) can't reach back via
  // `window.opener` / cross-origin DOM access. Critical when we
  // later embed Unlayer's editor iframe.
  // COEP is intentionally NOT set. `require-corp` would block
  // cross-origin embeds (Unlayer editor iframe, SendGrid pixels)
  // unless those origins serve CORP headers. `credentialless`
  // would force credential-stripped fetches that may break OAuth
  // callback flows. Revisit when Unlayer compatibility is confirmed.
  // Referrer-Policy `strict-origin-when-cross-origin` matches the
  // modern browser default; setting it explicitly avoids relying
  // on user-agent defaults.
  // Permissions-Policy denies device features the CRM never uses
  // so a future feature can't accidentally turn them on without an
  // explicit grant. Camera/microphone/geolocation are obvious; we
  // also deny payment, usb, midi, magnetometer, gyroscope, and
  // accelerometer so a marketing template iframe cannot probe
  // hardware sensors.
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
