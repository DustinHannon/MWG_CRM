import Link from "next/link";
import { signOut } from "@/auth";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * Authenticated app shell. Sidebar uses Phase 3 glass tokens. The
 * bottom-left identity block is the Phase 1/2 static block — it's
 * replaced by <UserPanel> in Phase 3B (which also moves Sign out into
 * a popover menu and adds Settings).
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireSession();

  return (
    <div className="flex min-h-screen text-foreground">
      <aside className="relative w-60 shrink-0 border-r border-glass-border bg-glass-1 [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))]">
        <div className="px-5 py-6">
          <Link href="/dashboard" className="block">
            <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              Morgan White Group
            </p>
            <p className="mt-1 text-sm font-semibold">MWG CRM</p>
          </Link>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          <SidebarLink href="/dashboard" label="Dashboard" />
          <SidebarLink href="/leads" label="Leads" />
          {user.isAdmin ? (
            <>
              <div className="my-3 h-px bg-glass-border" />
              <SidebarLink href="/admin" label="Admin" />
            </>
          ) : null}
        </nav>
        <div className="absolute bottom-0 w-60 border-t border-glass-border px-5 py-4">
          <p className="truncate text-xs text-foreground/80">{user.displayName}</p>
          <p className="truncate text-[10px] text-muted-foreground">{user.email}</p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/auth/signin" });
            }}
            className="mt-2"
          >
            <button
              type="submit"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
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
