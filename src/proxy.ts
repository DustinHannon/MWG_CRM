import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 proxy (formerly "middleware"). Auth.js v5's full session
 * decoding requires the Node runtime because our JWT callback queries the
 * DB; doing that here would force a heavy postgres driver into the Edge
 * runtime.
 *
 * Instead we do a *lightweight* check here: if the auth cookie is missing,
 * redirect to /auth/signin. The actual session validation (is_active,
 * sessionVersion, isAdmin) happens in server components and route handlers,
 * which run on Node and call `auth()` from src/auth.ts.
 */
const PUBLIC_PATH_PREFIXES = [
  "/auth/",
  "/api/auth/",
  "/_next/",
  "/favicon",
  "/robots.txt",
  "/sitemap.xml",
];

// Auth.js may CHUNK the session cookie when the JWT exceeds ~4KB. The chunked
// names look like `authjs.session-token.0`, `authjs.session-token.1`, etc. We
// match the prefix so chunked sessions are recognised here.
const SESSION_COOKIE_PREFIXES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

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

  return NextResponse.next();
}

export const config = {
  // Match all paths except Next.js internals and static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
