import { AppShell } from "@/components/app-shell/app-shell";
import { ADMIN_NAV_ITEMS, type NavItem } from "@/components/app-shell/nav";
import { QueryProvider } from "@/components/providers/query-provider";
import { PageRealtime } from "@/components/realtime/page-realtime";
import { RealtimeProvider } from "@/components/realtime/realtime-provider";
import { getPermissions, requireSession } from "@/lib/auth-helpers";
import { hasAnyMarketingView } from "@/lib/permissions/role-bundles";

export const dynamic = "force-dynamic";

const APP_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", iconKey: "LayoutDashboard" },
  { label: "Leads", href: "/leads", iconKey: "Users" },
  { label: "Accounts", href: "/accounts", iconKey: "Building2" },
  { label: "Contacts", href: "/contacts", iconKey: "Contact" },
  { label: "Opportunities", href: "/opportunities", iconKey: "Target" },
  { label: "Tasks", href: "/tasks", iconKey: "CheckSquare" },
  // Reports tab. Page-level gate enforces canViewReports;
  // this entry is visible to every authenticated user. The page
  // bounces non-permitted users back to /leads itself.
  { label: "Reports", href: "/reports", iconKey: "BarChart3" },
];

// Marketing nav. Inserted after Reports for users with any marketing
// view permission (or admin). The page-level gate in
// /marketing/layout.tsx is the source of truth — this nav entry just
// hides the link from non-permitted users so it doesn't bounce.
const MARKETING_NAV_ITEM: NavItem = {
  label: "Marketing",
  href: "/marketing",
  iconKey: "Mail",
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSession();
  const perms = await getPermissions(user.id);

  // hide Dashboard for users without canViewReports. Admin
  // always sees it. Keeps nav in sync with the page-level gate so users
  // don't see a link that bounces them back to /leads.
  const baseNav =
    user.isAdmin || perms.canViewReports
      ? APP_NAV
      : APP_NAV.filter((item) => !("href" in item) || item.href !== "/dashboard");

  // append Marketing for users with any marketing view permission
  // (or admin). The /marketing layout double-checks; this just hides
  // the link.
  const navWithMarketing: NavItem[] =
    user.isAdmin || hasAnyMarketingView(perms)
      ? [...baseNav, MARKETING_NAV_ITEM]
      : baseNav;

  // admins get an expandable Admin group that exposes
  // every admin sub-page inline. Auto-expands when the active route
  // is under /admin. The (app) shell renders the group; the /admin
  // shell renders the same items flat under its own subtitle so users
  // who navigate via /admin still get the same nav surface.
  const nav: NavItem[] = user.isAdmin
    ? [
        ...navWithMarketing,
        { divider: true },
        {
          label: "Admin",
          href: "/admin",
          iconKey: "Settings",
          children: ADMIN_NAV_ITEMS,
        },
      ]
    : navWithMarketing;
  return (
    <QueryProvider>
      <RealtimeProvider userId={user.id}>
        {/*
          layout-level notifications subscription so the topbar
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
    </QueryProvider>
  );
}
