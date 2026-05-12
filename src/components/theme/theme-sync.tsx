"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

/**
 * DB is the source of truth for a user's theme preference.
 * Mounted in the authenticated app layout, this client component reads
 * the theme value the server fetched from `user_preferences.theme` and
 * pushes it into next-themes if they disagree. That way, changing the
 * theme on device A propagates to device B on next sign-in.
 *
 * Renders nothing — it is purely a side-effect bridge.
 */
export function ThemeSync({ theme }: { theme: "system" | "light" | "dark" }) {
  const { theme: current, setTheme } = useTheme();
  useEffect(() => {
    if (current && current !== theme) {
      setTheme(theme);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
  return null;
}
