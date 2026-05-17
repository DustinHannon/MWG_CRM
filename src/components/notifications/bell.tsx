"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { markAllSeenAction } from "./actions";
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
  isRead: boolean;
  createdAt: Date;
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
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {formatUserTime(n.createdAt, prefs)}
                      </p>
                    </>
                  )}
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
