import { NotificationsBell } from "@/components/notifications/bell";
import type { TimePrefs } from "@/lib/format-time";

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: Date;
}

interface TopBarProps {
  unreadCount: number;
  recent: NotificationItem[];
  prefs: TimePrefs;
}

/**
 * Top-right floating chrome. Today this is just the notification bell;
 * the Cmd+K trigger lives in the global CommandPalette and isn't a
 * visible button. If a future phase adds a visible palette button it
 * goes here next to the bell.
 */
export function TopBar({ unreadCount, recent, prefs }: TopBarProps) {
  return (
    <div className="absolute right-6 top-6 z-10">
      <NotificationsBell unreadCount={unreadCount} recent={recent} prefs={prefs} />
    </div>
  );
}
