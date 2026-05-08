import { Breadcrumbs } from "@/components/breadcrumbs";
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
 * space. Phase 11: hosts the data-aware breadcrumb trail (left), and
 * the existing Search affordance + notification bell (right).
 *
 * Layout: `shrink-0 h-14` so it reserves space in the parent flex
 * column. Page content lives in a sibling scroll region beneath it,
 * so content can never flow under the bar.
 */
export function TopBar({ unreadCount, recent, prefs }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-glass-border bg-glass-1/40 px-6 [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))]">
      <Breadcrumbs />
      <div className="flex shrink-0 items-center gap-2">
        <SearchTrigger />
        <NotificationsBell unreadCount={unreadCount} recent={recent} prefs={prefs} />
      </div>
    </header>
  );
}
