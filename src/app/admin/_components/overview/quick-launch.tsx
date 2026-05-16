import Link from "next/link";

/**
 * Launchpad to the deep admin tools. The overview is the admin
 * landing page; these tiles give one-click access to the detailed
 * dashboards each summary above is drawn from. Labels mirror the
 * admin nav (sentence case, no vendor names).
 */
const LINKS: { label: string; href: string }[] = [
  { label: "Insights", href: "/admin/insights" },
  { label: "Server metrics", href: "/admin/server-metrics" },
  { label: "Database metrics", href: "/admin/supabase-metrics" },
  { label: "Email failures", href: "/admin/email-failures" },
  { label: "Audit log", href: "/admin/audit" },
  { label: "Users", href: "/admin/users" },
];

export function QuickLaunch() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="rounded-2xl border border-border bg-muted/40 p-5 text-sm font-medium text-foreground transition hover:bg-muted hover:border-foreground/20"
        >
          {l.label}
        </Link>
      ))}
    </div>
  );
}
