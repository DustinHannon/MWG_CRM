import type { ReactNode } from "react";
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
  /** Phase 12 Sub-E — mobile drawer trigger rendered before breadcrumbs at <1024px. */
  mobileNavTrigger?: ReactNode;
}

/**
 * Top bar — sticky horizontal chrome that reserves its own vertical
 * space. Phase 11: hosts the data-aware breadcrumb trail (left), and
 * the existing Search affordance + notification bell (right).
 *
 * Layout: `shrink-0 h-14` so it reserves space in the parent flex
 * column. Page content lives in a sibling scroll region beneath it,
 * so content can never flow under the bar.
 *
 * Phase 12 Sub-E — gap and horizontal padding tighten on mobile so the
 * mobile drawer trigger + breadcrumbs + search + bell fit a 380px
 * viewport without horizontal overflow. The breadcrumb wrapper gains
 * `min-w-0 flex-1 overflow-hidden` so it can truncate instead of
 * pushing the right-side controls off-screen.
 */
export function TopBar({
  unreadCount,
  recent,
  prefs,
  mobileNavTrigger,
}: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-glass-border bg-glass-1/40 px-3 [backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturate))] sm:gap-3 sm:px-6">
      {mobileNavTrigger}
      <div className="min-w-0 flex-1 overflow-hidden">
        <Breadcrumbs />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <SearchTrigger />
        <NotificationsBell unreadCount={unreadCount} recent={recent} prefs={prefs} />
      </div>
    </header>
  );
}
