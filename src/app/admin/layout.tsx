import { AppShell } from "@/components/app-shell/app-shell";
import { ADMIN_NAV_ITEMS, type NavItem } from "@/components/app-shell/nav";
import { QueryProvider } from "@/components/providers/query-provider";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

// Source of truth for the admin sub-nav lives in `nav.ts` so the (app)
// shell's expandable Admin group and this dedicated /admin shell stay
// in sync. Each new admin page is added in one place.
const ADMIN_NAV: NavItem[] = [
  ...ADMIN_NAV_ITEMS,
  { divider: true },
  { label: "Back to dashboard", href: "/dashboard", iconKey: "ArrowLeft" },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireAdmin();
  return (
    <QueryProvider>
      <AppShell user={user} brand={{ subtitle: "Admin" }} nav={ADMIN_NAV}>
        {children}
      </AppShell>
    </QueryProvider>
  );
}
