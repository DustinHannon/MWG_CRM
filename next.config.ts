import type { NextConfig } from "next";

/**
 * Security headers — applied to every route. CSP moved to per-request
 * generation in src/proxy.ts (Phase 3J — nonce-based with strict-dynamic).
 * Static directives that don't need a nonce stay here.
 *
 * verify after deploy:
 *   curl -sI https://crm.morganwhite.com | rg -i 'strict-transport|x-frame|x-content|referrer|permissions|content-security'
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Permissions-Policy here is the FALLBACK applied to responses the
  // proxy short-circuits (e.g. /api/v1/* keeps the static set; /dashboard
  // 307 redirects emit this header before the redirect body). The proxy
  // overrides this with the broader Phase 20 list (adds usb/midi/
  // magnetometer/gyroscope/accelerometer) on dynamic responses. Keep
  // both lists synchronized so a request that happens to bypass the
  // proxy still denies the same baseline of device features.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Phase 22 — block speculative cross-origin reads of any response from
  // this origin (Spectre-class side-channel mitigation). `same-origin`
  // is safe because no third-party site is expected to embed our assets;
  // Unlayer's editor iframe is hosted at editor.unlayer.com (loaded BY
  // us, not loading us). If a future workflow needs cross-origin embedding
  // of static assets, narrow this per-route rather than weakening the
  // global default.
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  experimental: {
    serverActions: {
      // XLSX imports arrive as multipart FormData through Server Actions,
      // whose default body cap is 1 MB — far below the in-action size
      // gates (MAX_IMPORT_BYTES = 25 MB for leads,
      // STATIC_LIST_IMPORT_MAX_BYTES = 10 MB for marketing lists). Without
      // this, the framework rejects normal multi-thousand-row spreadsheets
      // with an opaque 413 before the action runs, and the friendly
      // "File too large" message plus the magic-byte check never execute.
      // Sized to the largest cap (25 MB) plus multipart overhead so those
      // in-action checks become the real enforcement boundary.
      bodySizeLimit: "26mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
