import type { NextConfig } from "next";

/**
 * Security headers — applied to every route.
 *
 * The CSP starts permissive on style/script (Radix and react-hook-form
 * components inject inline styles; tightening to nonce-based requires
 * coordinated middleware work — tracked in ROADMAP). All other directives
 * are tight: frame-ancestors 'none' kills clickjacking, form-action limits
 * outbound POSTs to self + Microsoft login, and connect-src lists every
 * remote we actually call (Supabase Postgres + REST, Microsoft login +
 * Graph, Vercel Blob).
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
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://vercel.live https://*.vercel-scripts.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https://*.public.blob.vercel-storage.com https://graph.microsoft.com",
      "connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com https://*.supabase.co wss://*.supabase.co https://*.vercel.app https://vercel.live wss://ws-us3.pusher.com",
      "frame-ancestors 'none'",
      "form-action 'self' https://login.microsoftonline.com",
      "base-uri 'self'",
    ].join("; "),
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
