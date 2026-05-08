import { NotificationsBell } from "@/components/notifications/bell";
import type { TimePrefs } from "@/lib/format-time";
import { SearchTrigger } from "./search-trigger";

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
 * Top-right floating chrome. Visible Search affordance + notification
 * bell. The Search button dispatches `mwg:command-palette-open`; the
 * global CommandPalette listens for it. Cmd+K still works.
 */
export function TopBar({ unreadCount, recent, prefs }: TopBarProps) {
  return (
    <div className="absolute right-6 top-6 z-10 flex items-center gap-2">
      <SearchTrigger />
      <NotificationsBell unreadCount={unreadCount} recent={recent} prefs={prefs} />
    </div>
  );
}
