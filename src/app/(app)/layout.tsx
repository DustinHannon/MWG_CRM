import { eq } from "drizzle-orm";
import Link from "next/link";
import { Toaster } from "sonner";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { NotificationsBell } from "@/components/notifications/bell";
import { ThemeSync } from "@/components/theme/theme-sync";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserPanel } from "@/components/user-panel/user-panel";
import { db } from "@/db";
import { userPreferences } from "@/db/schema/views";
import { requireSession } from "@/lib/auth-helpers";
import {
  countUnread,
  listNotificationsForUser,
} from "@/lib/notifications";
import { listRecentForUser } from "@/lib/recent-views";

export const dynamic = "force-dynamic";

/**
 * Authenticated app shell with Phase 3 glass tokens. The bottom-left
 * identity area is now <UserPanel> (Phase 3B) — clickable card opening
 * a popover with Settings + Sign out. Theme toggle moved to /settings.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSession();
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
      <div
        data-density={density}
        className="flex min-h-screen text-foreground"
      >
        <aside className="relative flex w-60 shrink-0 flex-col border-r border-glass-border bg-glass-1 [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))]">
          <div className="px-5 py-6">
            <Link href="/dashboard" className="block">
              <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                Morgan White Group
              </p>
              <p className="mt-1 text-sm font-semibold">MWG CRM</p>
            </Link>
          </div>
          <nav className="flex flex-1 flex-col gap-1 px-3">
            <SidebarLink href="/dashboard" label="Dashboard" />
            <SidebarLink href="/leads" label="Leads" />
            <SidebarLink href="/accounts" label="Accounts" />
            <SidebarLink href="/contacts" label="Contacts" />
            <SidebarLink href="/opportunities" label="Opportunities" />
            <SidebarLink href="/tasks" label="Tasks" />
            {user.isAdmin ? (
              <>
                <div className="my-3 h-px bg-glass-border" />
                <SidebarLink href="/admin" label="Admin" />
              </>
            ) : null}
          </nav>
          <div className="border-t border-glass-border p-3">
            <UserPanel
              userId={user.id}
              displayName={user.displayName}
              email={user.email}
              jobTitle={user.jobTitle}
              photoUrl={user.photoUrl}
            />
          </div>
        </aside>
        <main className="relative flex-1 overflow-y-auto">
          <div className="absolute right-6 top-6 z-10">
            <NotificationsBell
              unreadCount={unreadCount}
              recent={recentNotifs}
              prefs={timePrefs}
            />
          </div>
          {children}
        </main>
      </div>
      <CommandPalette recent={recentViews} />
      <Toaster theme="dark" position="bottom-right" />
    </TooltipProvider>
  );
}

function SidebarLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
    >
      {label}
    </Link>
  );
}
