import { AppShell } from "@/components/app-shell/app-shell";
import type { NavItem } from "@/components/app-shell/nav";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { getPermissions, requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

const APP_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Leads", href: "/leads" },
  { label: "Accounts", href: "/accounts" },
  { label: "Contacts", href: "/contacts" },
  { label: "Opportunities", href: "/opportunities" },
  { label: "Tasks", href: "/tasks" },
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
    ? [...baseNav, { divider: true }, { label: "Admin", href: "/admin" }]
    : baseNav;
  return (
    <RealtimeProvider userId={user.id}>
      <AppShell user={user} nav={nav}>
        {children}
      </AppShell>
    </RealtimeProvider>
  );
}
