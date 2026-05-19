"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  markAllSeenAction,
  restoreFromNotificationAction,
} from "./actions";
import { toast } from "sonner";
import {
  formatUserTime,
  type TimePrefs,
} from "@/lib/format-time";

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  /** Entity discriminator for actionable rows (archive_pending). */
  entityType: string | null;
  /** Entity id for actionable rows (archive_pending). */
  entityId: string | null;
  isRead: boolean;
  createdAt: Date;
}

/**
 * Restore button for an actionable `archive_pending` notification.
 * Dispatches restoreFromNotificationAction with the snapshotted
 * entityType + entityId. The server action runs the same
 * canDelete<E> gate as the per-entity restoreXAction (single code
 * path, two entry points) and marks the notification is_read = true
 * on success — we mirror the read state locally via the `isResolved`
 * prop so the button shows "Restored" until the next server refresh.
 *
 * Failure modes the user sees:
 *   - "Restored"          — success (button disables).
 *   - "No longer available" — entity was hard-deleted (NotFoundError)
 *                              or the purge cron caught it.
 *   - error toast         — any other ForbiddenError / validation.
 */
function RestoreNotificationButton({
  notificationId,
  entityType,
  entityId,
  isResolved,
}: {
  notificationId: string;
  entityType: string;
  entityId: string;
  isResolved: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [doneState, setDoneState] = useState<
    "idle" | "restored" | "unavailable"
  >(isResolved ? "restored" : "idle");

  function handleRestore(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      const res = await restoreFromNotificationAction({
        notificationId,
        entityType,
        entityId,
      });
      if (res.ok) {
        setDoneState("restored");
        toast.success("Restored.");
        return;
      }
      const msg = res.error ?? "Restore failed.";
      if (/not found|permanently deleted|no longer/i.test(msg)) {
        setDoneState("unavailable");
        toast.error("No longer available.");
        return;
      }
      toast.error(msg);
    });
  }

  if (doneState === "restored") {
    return (
      <button
        type="button"
        disabled
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
      >
        Restored
      </button>
    );
  }
  if (doneState === "unavailable") {
    return (
      <button
        type="button"
        disabled
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
      >
        No longer available
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={handleRestore}
      disabled={pending}
      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-foreground transition hover:bg-primary/20 disabled:opacity-50"
    >
      {pending ? "Restoring…" : "Restore"}
    </button>
  );
}

interface BellProps {
  unseenCount: number;
  recent: NotificationItem[];
  prefs: TimePrefs;
}

export function NotificationsBell({ unseenCount, recent, prefs }: BellProps) {
  const [pending, startTransition] = useTransition();

  function markAll() {
    startTransition(async () => {
      const res = await markAllSeenAction();
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Notifications (${unseenCount} unseen)`}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Bell size={18} />
          {unseenCount > 0 ? (
            <span className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
              {unseenCount > 99 ? "99+" : unseenCount}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] p-0"
      >
        <div className="flex items-center justify-between border-b border-glass-border p-3">
          <p className="text-sm font-semibold">Notifications</p>
          <button
            type="button"
            onClick={markAll}
            disabled={pending || unseenCount === 0}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Mark all seen
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {recent.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">
              No notifications yet.
            </p>
          ) : (
            <ul className="divide-y divide-glass-border">
              {recent.map((n) => (
                <li
                  key={n.id}
                  className={
                    "p-3 text-sm " +
                    (n.isRead ? "" : "bg-primary/5")
                  }
                >
                  {n.link ? (
                    <Link href={n.link} className="block hover:underline">
                      <p className="font-medium">{n.title}</p>
                      {n.body ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {n.body}
                        </p>
                      ) : null}
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {formatUserTime(n.createdAt, prefs)}
                      </p>
                    </Link>
                  ) : (
                    <>
                      <p className="font-medium">{n.title}</p>
                      {n.body ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {n.body}
                        </p>
                      ) : null}
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {formatUserTime(n.createdAt, prefs)}
                      </p>
                    </>
                  )}
                  {n.kind === "archive_pending" &&
                  n.entityType &&
                  n.entityId ? (
                    <RestoreNotificationButton
                      notificationId={n.id}
                      entityType={n.entityType}
                      entityId={n.entityId}
                      isResolved={n.isRead}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-glass-border p-2 text-center">
          <Link
            href="/notifications"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            View all
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
