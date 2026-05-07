import Link from "next/link";
import { Toaster } from "sonner";
import { NotificationsBell } from "@/components/notifications/bell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserPanel } from "@/components/user-panel/user-panel";
import { requireSession } from "@/lib/auth-helpers";
import {
  countUnread,
  listNotificationsForUser,
} from "@/lib/notifications";

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
  const [unreadCount, recentNotifs] = await Promise.all([
    countUnread(user.id),
    listNotificationsForUser(user.id, 10),
  ]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-screen text-foreground">
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
            />
          </div>
          {children}
        </main>
      </div>
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
