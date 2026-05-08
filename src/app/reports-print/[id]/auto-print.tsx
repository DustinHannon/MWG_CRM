"use client";

import { useEffect } from "react";

/**
 * Phase 11 — auto-open the system print dialog after the report
 * print-template mounts. Mirrors src/app/leads/print/[id]/auto-print.tsx
 * so the user can pick "Save as PDF" without an extra server-side
 * Chromium dependency.
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
