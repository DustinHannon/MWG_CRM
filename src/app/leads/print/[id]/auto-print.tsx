"use client";

import { useEffect } from "react";

/**
 * auto-open the browser print dialog after the page
 * has finished mounting. Replaces a server-rendered inline <script> that
 * was blocked by the strict CSP set in src/proxy.ts (no nonce passthrough
 * on a `<script dangerouslySetInnerHTML>` element).
 *
 * Lives as a tiny client component instead of carrying a nonce because
 * the useEffect path doesn't need any inline-script CSP exception.
 */
export function AutoPrint() {
  useEffect(() => {
    const t = setTimeout(() => {
      window.print();
    }, 250);
    return () => clearTimeout(t);
  }, []);
  return null;
}
