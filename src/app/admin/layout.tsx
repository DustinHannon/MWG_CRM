import Link from "next/link";
import { requireAdmin } from "@/lib/auth-helpers";
import { signOut } from "@/auth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireAdmin();

  return (
    <div className="flex min-h-screen bg-slate-950 text-white">
      <aside className="w-60 border-r border-white/10 bg-white/5 backdrop-blur-xl">
        <div className="px-5 py-6">
          <Link href="/dashboard" className="block">
            <p className="text-[10px] uppercase tracking-[0.3em] text-white/40">
              Morgan White Group
            </p>
            <p className="mt-1 text-sm font-semibold">MWG CRM Admin</p>
          </Link>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          <SidebarLink href="/admin" label="Overview" />
          <SidebarLink href="/admin/users" label="Users" />
          <SidebarLink href="/admin/tags" label="Tags" />
          <SidebarLink href="/admin/scoring" label="Scoring" />
          <SidebarLink href="/admin/audit" label="Audit log" />
          <SidebarLink href="/admin/data" label="Data tools" />
          <SidebarLink href="/admin/import-help" label="Import help" />
          <SidebarLink href="/admin/settings" label="Settings" />
          <div className="my-3 h-px bg-white/10" />
          <SidebarLink href="/dashboard" label="← Back to dashboard" />
        </nav>
        <div className="absolute bottom-0 w-60 border-t border-white/10 px-5 py-4">
          <p className="truncate text-xs text-white/50">{user.displayName}</p>
          <p className="truncate text-[10px] text-white/30">{user.email}</p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/auth/signin" });
            }}
            className="mt-2"
          >
            <button
              type="submit"
              className="text-xs text-white/50 underline-offset-4 hover:text-white/80 hover:underline"
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
      className="rounded-md px-3 py-2 text-sm text-white/70 transition hover:bg-white/5 hover:text-white"
    >
      {label}
    </Link>
  );
}
