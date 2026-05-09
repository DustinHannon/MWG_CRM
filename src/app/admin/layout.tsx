import { AppShell } from "@/components/app-shell/app-shell";
import type { NavItem } from "@/components/app-shell/nav";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

const ADMIN_NAV: NavItem[] = [
  { label: "Overview", href: "/admin", iconKey: "Home" },
  { label: "Users", href: "/admin/users", iconKey: "UserCog" },
  { label: "Tags", href: "/admin/tags", iconKey: "Tag" },
  { label: "Scoring", href: "/admin/scoring", iconKey: "Star" },
  { label: "Audit log", href: "/admin/audit", iconKey: "ScrollText" },
  { label: "Data tools", href: "/admin/data", iconKey: "Database" },
  { label: "Import help", href: "/admin/import-help", iconKey: "HelpCircle" },
  { label: "Settings", href: "/admin/settings", iconKey: "SlidersHorizontal" },
  // Phase 13 — API Keys (Sub-A) and API Usage (Sub-C).
  { label: "API Keys", href: "/admin/api-keys", iconKey: "Key" },
  { label: "API Usage", href: "/admin/api-usage", iconKey: "Activity" },
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
    <AppShell user={user} brand={{ subtitle: "Admin" }} nav={ADMIN_NAV}>
      {children}
    </AppShell>
  );
}
