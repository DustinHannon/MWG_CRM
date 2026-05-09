import {
  BarChart3,
  Building2,
  CheckSquare,
  Contact,
  LayoutDashboard,
  Settings,
  Target,
  Users,
} from "lucide-react";
import { AppShell } from "@/components/app-shell/app-shell";
import type { NavItem } from "@/components/app-shell/nav";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

const APP_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Leads", href: "/leads", icon: Users },
  { label: "Accounts", href: "/accounts", icon: Building2 },
  { label: "Contacts", href: "/contacts", icon: Contact },
  { label: "Opportunities", href: "/opportunities", icon: Target },
  { label: "Tasks", href: "/tasks", icon: CheckSquare },
  // Phase 13 — Reports tab. Page-level gate enforces canViewReports;
  // this entry is visible to every authenticated user. The page
  // bounces non-permitted users back to /leads itself.
  { label: "Reports", href: "/reports", icon: BarChart3 },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);

  // Phase 9C — hide Dashboard for users without canViewReports. Admin
  // always sees it. Keeps nav in sync with the page-level gate so users
  // don't see a link that bounces them back to /leads.
  const baseNav =
    user.isAdmin || perms.canViewReports
      ? APP_NAV
      : APP_NAV.filter((item) => !("href" in item) || item.href !== "/dashboard");

  const nav: NavItem[] = user.isAdmin
    ? [
        ...baseNav,
        { divider: true },
        { label: "Admin", href: "/admin", icon: Settings },
      ]
    : baseNav;
  return (
    <RealtimeProvider userId={user.id}>
      {/*
        Phase 12 — layout-level notifications subscription so the topbar
        bell updates everywhere without each page re-mounting it. Filter
        scopes to the current user; RLS doubly enforces that.
      */}
      <PageRealtime
        entities={["notifications"]}
        filter={`user_id=eq.${user.id}`}
      />
      <AppShell user={user} nav={nav}>
        {children}
      </AppShell>
    </RealtimeProvider>
  );
}
