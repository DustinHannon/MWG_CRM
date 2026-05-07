import type { NextConfig } from "next";

/**
 * Security headers — applied to every route. CSP moved to per-request
 * generation in src/proxy.ts (Phase 3J — nonce-based with strict-dynamic).
 * Static directives that don't need a nonce stay here.
 *
 * verify after deploy:
 *   curl -sI https://mwg-crm.vercel.app | rg -i 'strict-transport|x-frame|x-content|referrer|permissions|content-security'
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
