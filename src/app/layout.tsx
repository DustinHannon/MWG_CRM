import type { Metadata } from "next";
import { Fraunces, Geist, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";

const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  axes: ["opsz", "SOFT"],
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "MWG CRM",
  description:
    "Internal CRM platform for Morgan White Group — lead and relationship management with Microsoft Entra SSO and Outlook integration.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Phase 8 (FIX-005) — pass the per-request CSP nonce minted by
  // src/proxy.ts to next-themes so its inline FOUC-prevention <script>
  // is allowed by the strict script-src directive.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      className={`${geist.variable} ${fraunces.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased font-sans">
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
        {/* Phase 26 follow-up — Vercel first-party telemetry SDKs.
            `<SpeedInsights />` collects p75 LCP/INP/CLS/FCP/TTFB and
            posts to https://vitals.vercel-analytics.com.
            `<Analytics />` collects page-view + visitor-country and
            posts to https://va.vercel-scripts.com. Both also require
            the matching connect-src / script-src CSP entries set in
            src/proxy.ts so the strict CSP doesn't block them. */}
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
