/**
 * sidebar navigation primitives.
 *
 * IMPORTANT: nav arrays are built in server components (`(app)/layout.tsx`,
 * `admin/layout.tsx`) and consumed by client components (`Sidebar`,
 * `MobileSidebar`). React Server Component serialization rejects function
 * references crossing the boundary ("Functions cannot be passed directly
 * to Client Components"), so we cannot put a `LucideIcon` (which is a
 * React component, i.e. a function) directly on the prop.
 *
 * The fix: server-side data carries a string `iconKey`. The client
 * component imports `ICON_MAP` from this same module — module-level
 * imports happen on each side independently, so the lucide function
 * never travels through the RSC payload.
 */

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Server,
  Building2,
  CheckSquare,
  Contact,
  Database,
  DownloadCloud,
  HelpCircle,
  Home,
  Key,
  LayoutDashboard,
  Mail,
  MailWarning,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Star,
  Tag,
  Target,
  UserCog,
  Users,
} from "lucide-react";

export const ICON_KEYS = [
  // Main app nav
  "LayoutDashboard",
  "Users",
  "Building2",
  "Contact",
  "Target",
  "CheckSquare",
  "BarChart3",
  "Mail",
  "Settings",
  // Admin nav
  "Home",
  "UserCog",
  "Tag",
  "Star",
  "ScrollText",
  "Database",
  "HelpCircle",
  "SlidersHorizontal",
  "Key",
  "Activity",
  "MailWarning",
  "DownloadCloud",
  "ArrowLeft",
  "Server",
] as const;

export type IconKey = (typeof ICON_KEYS)[number];

export const ICON_MAP: Record<IconKey, LucideIcon> = {
  LayoutDashboard,
  Users,
  Building2,
  Contact,
  Target,
  CheckSquare,
  BarChart3,
  Mail,
  Settings,
  Home,
  UserCog,
  Tag,
  Star,
  ScrollText,
  Database,
  HelpCircle,
  SlidersHorizontal,
  Key,
  Activity,
  MailWarning,
  DownloadCloud,
  ArrowLeft,
  Server,
};

export type NavLink = { label: string; href: string; iconKey?: IconKey };
export type NavGroup = {
  label: string;
  iconKey?: IconKey;
  /** Used to match `pathname.startsWith(href)` for auto-expand / active state. */
  href: string;
  children: NavLink[];
};
export type NavItem =
  | NavLink
  | NavGroup
  | { divider: true };

export function isDivider(
  item: NavItem,
): item is { divider: true } {
  return "divider" in item && item.divider === true;
}

export function isGroup(item: NavItem): item is NavGroup {
  return !isDivider(item) && "children" in item;
}

export function isLink(item: NavItem): item is NavLink {
  return !isDivider(item) && !isGroup(item);
}

/**
 * the admin section's nav items. Exported so
 * both the (app) shell (renders this as a collapsible group) and the
 * /admin shell (renders this as flat siblings under an "Admin" header)
 * consume the same source list.
 */
export const ADMIN_NAV_ITEMS: NavLink[] = [
  { label: "Overview", href: "/admin", iconKey: "Home" },
  { label: "Users", href: "/admin/users", iconKey: "UserCog" },
  { label: "Scoring", href: "/admin/scoring", iconKey: "Star" },
  { label: "Settings", href: "/admin/settings", iconKey: "SlidersHorizontal" },
  { label: "Audit log", href: "/admin/audit", iconKey: "ScrollText" },
  { label: "Data tools", href: "/admin/data", iconKey: "Database" },
  { label: "Import help", href: "/admin/import-help", iconKey: "HelpCircle" },
  { label: "D365 import", href: "/admin/d365-import", iconKey: "DownloadCloud" },
  { label: "API keys", href: "/admin/api-keys", iconKey: "Key" },
  { label: "API usage", href: "/admin/api-usage", iconKey: "Activity" },
  { label: "Insights", href: "/admin/insights", iconKey: "BarChart3" },
  { label: "Server logs", href: "/admin/server-logs", iconKey: "Server" },
  { label: "Supabase metrics", href: "/admin/supabase-metrics", iconKey: "Database" },
  { label: "Email failures", href: "/admin/email-failures", iconKey: "MailWarning" },
];
