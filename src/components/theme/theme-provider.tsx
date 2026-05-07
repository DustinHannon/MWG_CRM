"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Phase 5A — wraps next-themes' ThemeProvider with the CRM defaults:
 *   - attribute="class" so .dark vs (no class) toggles the right CSS in
 *     globals.css, where `:root` holds the light tokens and `.dark` the
 *     dark ones.
 *   - defaultTheme="dark" preserves the prior user-visible default.
 *     Authenticated users get their stored preference applied via
 *     <ThemeSync> in (app)/layout.tsx.
 *   - enableSystem honors the OS preference when the user picks "system".
 *   - disableTransitionOnChange prevents the brief flash of CSS transitions
 *     when the class swaps.
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
