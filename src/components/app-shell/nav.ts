/**
 * Phase 13 — sidebar navigation primitives.
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
};

export type NavItem =
  | { label: string; href: string; iconKey?: IconKey }
  | { divider: true };

export function isDivider(
  item: NavItem,
): item is { divider: true } {
  return "divider" in item && item.divider === true;
}
