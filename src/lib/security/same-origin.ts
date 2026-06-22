import "server-only";
import { NextResponse } from "next/server";

/**
 * App-layer CSRF defense for cookie-session mutating route handlers.
 *
 * Plain Next.js Route Handlers — unlike Server Actions — get no built-in
 * Origin check, so a state-changing POST/PATCH/PUT/DELETE authenticated by
 * the session cookie relies solely on the cookie's SameSite=Lax attribute.
 * Lax still permits SAME-SITE requests, so a compromised or attacker-
 * controlled sibling `*.morganwhite.com` origin could issue cookie-bearing
 * cross-subdomain writes that these handlers would honor.
 *
 * This asserts the request is genuinely SAME-ORIGIN and rejects anything
 * cross-origin — including same-site sibling subdomains. Call it at the very
 * top of every cookie-authenticated mutating route handler (the public REST
 * API under /api/v1/* is Bearer-authenticated and called cross-origin by
 * design, so it must NOT use this).
 *
 * Returns a 403 NextResponse to short-circuit, or `null` when the request is
 * same-origin (or carries no browser cross-origin signal at all — a
 * non-browser client that sends neither Sec-Fetch-Site nor Origin is not a
 * CSRF vector, since CSRF requires a browser, and browsers always attach
 * these on unsafe-method requests).
 *
 * The Host comparison is sound against forgery: in a CSRF the attacker
 * controls the page Origin but NOT the target Host header (the browser sets
 * Host to the real target), so Origin-host === Host holds only for true
 * same-origin requests.
 */
export function requireSameOrigin(req: Request): NextResponse | null {
  // Preferred signal: browsers send Sec-Fetch-Site on every request.
  //  - same-origin: allow
  //  - none:        user-initiated (typed URL / bookmark), not a fetch: allow
  //  - same-site:   sibling subdomain — cross-origin, the residual we block
  //  - cross-site:  block
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "same-origin" || secFetchSite === "none") return null;
  if (secFetchSite === "same-site" || secFetchSite === "cross-site") {
    return forbidden();
  }

  // Fallback for clients that don't send Sec-Fetch-Site: compare Origin host
  // to the request Host. Absent Origin -> no cross-origin evidence -> allow.
  const origin = req.headers.get("origin");
  if (origin === null) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return forbidden(); // malformed Origin
  }
  const host = req.headers.get("host");
  if (host && originHost === host) return null;
  return forbidden();
}

function forbidden(): NextResponse {
  return NextResponse.json({ error: "cross_origin_forbidden" }, { status: 403 });
}
