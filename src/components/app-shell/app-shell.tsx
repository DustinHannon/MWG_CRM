import { eq } from "drizzle-orm";
import { Toaster } from "sonner";
import { BreadcrumbsProvider } from "@/components/breadcrumbs";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { ThemeSync } from "@/components/theme/theme-sync";
import { TooltipProvider } from "@/components/ui/tooltip";
import { db } from "@/db";
import { userPreferences } from "@/db/schema/views";
import type { SessionUser } from "@/lib/auth-helpers";
import {
  countUnread,
  listNotificationsForUser,
} from "@/lib/notifications";
import { listRecentForUser } from "@/lib/recent-views";
import { MobileSidebar } from "./mobile-sidebar";
import type { NavItem } from "./nav";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

interface AppShellProps {
  /** Authenticated user — caller is responsible for gating. */
  user: SessionUser;
  /** Brand subtitle ("Admin" for the admin section, none for main app). */
  brand?: { subtitle?: string };
  /** Sidebar nav, including dividers. */
  nav: NavItem[];
  children: React.ReactNode;
}

/**
 * Phase 7B canonical authenticated shell. Replaces the inline shell
 * that used to live in `(app)/layout.tsx` and the divergent shell that
 * used to live in `admin/layout.tsx`. Every authenticated layout
 * resolves its own gating (`requireSession` or `requireAdmin`) and
 * passes the user in. AppShell never gates auth itself.
 *
 * Renders glass sidebar + bell + Cmd+K palette + toaster + theme sync.
 * Density and theme come from `user_preferences`.
 */
export async function AppShell({ user, brand, nav, children }: AppShellProps) {
  const [unreadCount, recentNotifs, recentViews, prefsRow] = await Promise.all([
    countUnread(user.id),
    listNotificationsForUser(user.id, 10),
    listRecentForUser(user.id, 5),
    db
      .select({
        theme: userPreferences.theme,
        tableDensity: userPreferences.tableDensity,
        timezone: userPreferences.timezone,
        dateFormat: userPreferences.dateFormat,
        timeFormat: userPreferences.timeFormat,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, user.id))
      .limit(1),
  ]);
  const prefs = prefsRow[0] ?? {
    theme: "system",
    tableDensity: "comfortable",
    timezone: "America/Chicago",
    dateFormat: "MM/DD/YYYY",
    timeFormat: "12h",
  };
  const theme = (prefs.theme === "light" || prefs.theme === "dark"
    ? prefs.theme
    : "system") as "system" | "light" | "dark";
  const density =
    prefs.tableDensity === "compact" ? "compact" : "comfortable";
  const timePrefs = {
    timezone: prefs.timezone || "America/Chicago",
    dateFormat: prefs.dateFormat || "MM/DD/YYYY",
    timeFormat: prefs.timeFormat === "24h" ? ("24h" as const) : ("12h" as const),
  };

  return (
    <TooltipProvider delayDuration={300}>
      <ThemeSync theme={theme} />
      <BreadcrumbsProvider>
        <div data-density={density} className="flex h-dvh text-foreground">
          <Sidebar brand={brand ?? {}} nav={nav} user={user} />
          <main className="flex h-dvh min-w-0 flex-1 flex-col">
            <TopBar
              unreadCount={unreadCount}
              recent={recentNotifs}
              prefs={timePrefs}
              mobileNavTrigger={
                <MobileSidebar brand={brand ?? {}} nav={nav} user={user} />
              }
            />
            <div className="flex-1 overflow-y-auto">{children}</div>
          </main>
        </div>
        <CommandPalette recent={recentViews} />
        <Toaster theme="dark" position="bottom-right" />
      </BreadcrumbsProvider>
    </TooltipProvider>
  );
}
