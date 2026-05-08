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
 * Top bar — sticky horizontal chrome that reserves its own vertical
 * space. Visible Search affordance + notification bell. The Search
 * button dispatches `mwg:command-palette-open`; the global
 * CommandPalette listens for it. Cmd+K still works.
 *
 * Layout: `shrink-0 h-14` so it reserves space in the parent flex
 * column. Page content lives in a sibling scroll region beneath it,
 * so content can never flow under the bar.
 */
export function TopBar({ unreadCount, recent, prefs }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-end gap-2 border-b border-glass-border bg-glass-1/40 px-6 [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))]">
      <SearchTrigger />
      <NotificationsBell unreadCount={unreadCount} recent={recent} prefs={prefs} />
    </header>
  );
}
