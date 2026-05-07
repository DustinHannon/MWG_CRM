import Link from "next/link";
import { UserPanel } from "@/components/user-panel/user-panel";
import type { SessionUser } from "@/lib/auth-helpers";
import { Brand } from "./brand";
import { isDivider, type NavItem } from "./nav";

interface SidebarProps {
  brand: { subtitle?: string };
  nav: NavItem[];
  user: SessionUser;
}

/**
 * Phase 7B — single sidebar shared by every authenticated layout. The
 * caller passes its own nav array so the main app and the admin
 * section can have different links without forking chrome.
 */
export function Sidebar({ brand, nav, user }: SidebarProps) {
  return (
    <aside className="relative flex w-60 shrink-0 flex-col border-r border-glass-border bg-glass-1 [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))]">
      <Brand subtitle={brand.subtitle} />
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {nav.map((item, i) => {
          if (isDivider(item)) {
            return <div key={`div-${i}`} className="my-3 h-px bg-glass-border" />;
          }
          return (
            <SidebarLink key={item.href} href={item.href} label={item.label} />
          );
        })}
      </nav>
      <div className="border-t border-glass-border p-3">
        <UserPanel
          userId={user.id}
          displayName={user.displayName}
          email={user.email}
          jobTitle={user.jobTitle}
          photoUrl={user.photoUrl}
        />
      </div>
    </aside>
  );
}

function SidebarLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
    >
      {label}
    </Link>
  );
}
