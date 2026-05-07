import { AppShell } from "@/components/app-shell/app-shell";
import type { NavItem } from "@/components/app-shell/nav";
import { requireSession } from "@/lib/auth-helpers";

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
  const nav: NavItem[] = user.isAdmin
    ? [...APP_NAV, { divider: true }, { label: "Admin", href: "/admin" }]
    : APP_NAV;
  return (
    <AppShell user={user} nav={nav}>
      {children}
    </AppShell>
  );
}
