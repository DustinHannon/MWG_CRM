"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { UserPanel } from "@/components/user-panel/user-panel";
import type { SessionUser } from "@/lib/auth-helpers";
import { Brand } from "./brand";
import {
  ICON_MAP,
  isDivider,
  isGroup,
  type NavGroup,
  type NavItem,
} from "./nav";

interface MobileSidebarProps {
  brand: { subtitle?: string };
  nav: NavItem[];
  user: SessionUser;
}

/**
 * slide-out drawer that reproduces the desktop
 * sidebar at <1024px. Trigger is a hamburger button in the top bar.
 * Auto-closes on route change so the user lands on the new page
 * without a stale overlay.
 *
 * Uses Radix Dialog for the focus trap, ESC handling, and portal
 * placement. The trigger is rendered inline so the topbar has a
 * single button it can position; the panel/overlay portals to
 * <body>.
 */
export function MobileSidebar({ brand, nav, user }: MobileSidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Derived state — close on route change. We track the last pathname
  // as state and compare against the current; if they diverge we reset
  // `open` to false in the same render. This pattern is the React-19
  // / react-compiler-friendly alternative to a useEffect that calls
  // setState (which would trigger a second render flash).
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open navigation"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-glass-border bg-card/40 text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
        >
          <Menu size={18} aria-hidden />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 lg:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-hidden border-r border-glass-border bg-glass-3 [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))] data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left lg:hidden"
        >
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <div className="flex items-center justify-between pr-2 pt-safe">
            <Brand subtitle={brand.subtitle} />
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close navigation"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={18} aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
            {nav.map((item, i) => {
              if (isDivider(item)) {
                return (
                  <div key={`div-${i}`} className="my-3 h-px bg-glass-border" />
                );
              }
              if (isGroup(item)) {
                return (
                  <MobileGroup
                    key={item.href}
                    group={item}
                    currentPath={pathname}
                  />
                );
              }
              const Icon = item.iconKey ? ICON_MAP[item.iconKey] : null;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-3 rounded-md px-3 py-2.5 text-base text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
                >
                  {Icon ? <Icon size={18} aria-hidden /> : null}
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-glass-border p-3 pb-safe">
            <UserPanel
              userId={user.id}
              displayName={user.displayName}
              email={user.email}
              jobTitle={user.jobTitle}
              photoUrl={user.photoUrl}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MobileGroup({
  group,
  currentPath,
}: {
  group: NavGroup;
  currentPath: string;
}) {
  const groupActive =
    currentPath === group.href || currentPath.startsWith(`${group.href}/`);
  const Icon = group.iconKey ? ICON_MAP[group.iconKey] : null;
  return (
    <div className="flex flex-col">
      <Link
        href={group.href}
        className="flex items-center gap-3 rounded-md px-3 py-2.5 text-base text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
      >
        {Icon ? <Icon size={18} aria-hidden /> : null}
        <span className="truncate">{group.label}</span>
      </Link>
      {groupActive ? (
        <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
          {group.children.map((child) => {
            const ChildIcon = child.iconKey ? ICON_MAP[child.iconKey] : null;
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
                >
                  {ChildIcon ? (
                    <ChildIcon size={14} aria-hidden />
                  ) : null}
                  <span className="truncate">{child.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
