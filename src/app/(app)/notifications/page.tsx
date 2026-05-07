import Link from "next/link";
import { GlassCard } from "@/components/ui/glass-card";
import { UserTime } from "@/components/ui/user-time";
import { requireSession } from "@/lib/auth-helpers";
import { listNotificationsForUser } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await requireSession();
  const list = await listNotificationsForUser(session.id, 100);

  return (
    <div className="px-10 py-10">
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        Notifications
      </p>
      <h1 className="mt-1 text-2xl font-semibold font-display">All notifications</h1>

      <GlassCard className="mt-6 overflow-hidden p-0">
        {list.length === 0 ? (
          <p className="p-12 text-center text-sm text-muted-foreground">
            No notifications.
          </p>
        ) : (
          <ul className="divide-y divide-glass-border">
            {list.map((n) => (
              <li
                key={n.id}
                className={"p-4 " + (n.isRead ? "" : "bg-primary/5")}
              >
                {n.link ? (
                  <Link href={n.link} className="block hover:underline">
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.body ? (
                      <p className="mt-1 text-xs text-muted-foreground">{n.body}</p>
                    ) : null}
                  </Link>
                ) : (
                  <>
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.body ? (
                      <p className="mt-1 text-xs text-muted-foreground">{n.body}</p>
                    ) : null}
                  </>
                )}
                <p className="mt-2 text-[10px] text-muted-foreground">
                  <UserTime value={n.createdAt} /> · {n.kind}
                </p>
              </li>
            ))}
          </ul>
        )}
      </GlassCard>
    </div>
  );
}
