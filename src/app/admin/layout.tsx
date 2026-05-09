import { Activity } from "lucide-react";
import { AppShell } from "@/components/app-shell/app-shell";
import type { NavItem } from "@/components/app-shell/nav";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

const ADMIN_NAV: NavItem[] = [
  { label: "Overview", href: "/admin" },
  { label: "Users", href: "/admin/users" },
  { label: "Tags", href: "/admin/tags" },
  { label: "Scoring", href: "/admin/scoring" },
  { label: "Audit log", href: "/admin/audit" },
  { label: "Data tools", href: "/admin/data" },
  { label: "Import help", href: "/admin/import-help" },
  { label: "Settings", href: "/admin/settings" },
  // Phase 13 — API Usage page (Sub-C). Sub-A inserts API Keys above
  // this line in a separate commit; if there's a conflict the merge
  // ordering should be: Settings → API Keys → API Usage → divider.
  { label: "API Usage", href: "/admin/api-usage", icon: Activity },
  { divider: true },
  { label: "← Back to dashboard", href: "/dashboard" },
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
