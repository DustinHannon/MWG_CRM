"use client";

import { ChevronsLeft, ChevronsRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserPanel } from "@/components/user-panel/user-panel";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SessionUser } from "@/lib/auth-helpers";
import { cn } from "@/lib/utils";
import { Brand } from "./brand";
import { ICON_MAP, isDivider, type NavItem } from "./nav";
import { useSidebarState } from "./use-sidebar-state";

interface SidebarProps {
  brand: { subtitle?: string };
  nav: NavItem[];
  user: SessionUser;
  /** Phase 13 — initial collapsed value from `user_preferences`. */
  initialCollapsed: boolean;
}

/**
 * Phase 7B — single sidebar shared by every authenticated layout. The
 * caller passes its own nav array so the main app and the admin
 * section can have different links without forking chrome.
 *
 * Phase 13 — collapsible (240px ↔ 64px) with persistent state, icon
 * mapping per nav item, and active-route accent. When collapsed,
 * labels become tooltips on hover/focus and the user profile panel
 * shows avatar-only. The mobile drawer (`<MobileSidebar>`) is unaffected
 * — it always renders at full width and ignores `initialCollapsed`.
 */
export function Sidebar({
  brand,
  nav,
  user,
  initialCollapsed,
}: SidebarProps) {
  const { collapsed, toggle } = useSidebarState(initialCollapsed);
  const pathname = usePathname();

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      style={{ width: collapsed ? 64 : 240 }}
      className="relative hidden h-dvh shrink-0 flex-col overflow-hidden border-r border-glass-border bg-glass-1 transition-[width] duration-200 ease-out [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))] lg:flex"
    >
      <Brand subtitle={brand.subtitle} collapsed={collapsed} />
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md border border-glass-border bg-card/40 text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {collapsed ? (
          <ChevronsRight size={14} aria-hidden />
        ) : (
          <ChevronsLeft size={14} aria-hidden />
        )}
      </button>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3">
        {nav.map((item, i) => {
          if (isDivider(item)) {
            return (
              <div
                key={`div-${i}`}
                className="my-3 h-px bg-glass-border"
                aria-hidden
              />
            );
          }
          return (
            <SidebarLink
              key={item.href}
              item={item}
              collapsed={collapsed}
              active={isActive(pathname, item.href)}
            />
          );
        })}
      </nav>
      <div
        className={cn(
          "border-t border-glass-border",
          collapsed ? "p-2" : "p-3",
        )}
      >
        <UserPanel
          userId={user.id}
          displayName={user.displayName}
          email={user.email}
          jobTitle={user.jobTitle}
          photoUrl={user.photoUrl}
          collapsed={collapsed}
        />
      </div>
    </aside>
  );
}

interface SidebarLinkProps {
  item: { label: string; href: string; iconKey?: keyof typeof ICON_MAP };
  collapsed: boolean;
  active: boolean;
}

function SidebarLink({ item, collapsed, active }: SidebarLinkProps) {
  const Icon = item.iconKey ? ICON_MAP[item.iconKey] : null;
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-md text-sm transition",
        // Active accent — left border + tinted bg.
        active
          ? "bg-accent/40 text-foreground"
          : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
        collapsed ? "h-9 justify-center px-0" : "px-3 py-2",
      )}
    >
      {/* Active left-border accent. Rendered absolute so collapsed
          mode (centered icon) still shows the indicator without
          shifting the icon. */}
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-foreground/80"
        />
      ) : null}
      {Icon ? (
        <Icon
          size={18}
          aria-hidden
          className={cn("shrink-0", active ? "text-foreground" : "")}
        />
      ) : null}
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <span className="truncate">{item.label}</span>
      )}
    </Link>
  );

  if (!collapsed) return link;

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Active-route matching. Exact match for `/`-rooted home pages, or
 * prefix match for nested routes (so `/reports/foo` highlights the
 * Reports entry). The "Overview" admin link at `/admin` is special —
 * we only want it active on the admin index, not all `/admin/*`
 * pages, since each sub-page has its own nav entry.
 */
function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === "/admin" || href === "/dashboard") return false;
  return pathname.startsWith(`${href}/`);
}
