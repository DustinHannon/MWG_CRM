"use client";

import Link from "next/link";
import { useCallback, useMemo } from "react";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { type TimePrefs } from "@/lib/format-time";

/**
 * Row shape served by /api/notifications/list (createdAt is an ISO
 * string over the wire). The raw `kind` is deliberately absent — it is
 * an internal discriminator, never user copy; the row self-describes
 * via the composed `title`.
 */
export interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

// The feed has no filters — it is the caller's own chronological
// activity log. StandardListPage is still generic over a filters
// object, so use a stable empty one (referential stability keeps the
// query key from churning).
type NotificationsFilters = Record<string, never>;
const NO_FILTERS: NotificationsFilters = {};

interface NotificationsListClientProps {
  timePrefs: TimePrefs;
}

export function NotificationsListClient({
  timePrefs,
}: NotificationsListClientProps) {
  const filters = useMemo<NotificationsFilters>(() => NO_FILTERS, []);

  const fetchPage = useCallback(
    async (
      cursor: string | null,
      _filters: NotificationsFilters,
      signal?: AbortSignal,
    ): Promise<StandardListPagePage<NotificationRow>> => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(
        `/api/notifications/list?${params.toString()}`,
        { headers: { Accept: "application/json" }, signal },
      );
      if (!res.ok) {
        throw new Error(`Could not load notifications (${res.status})`);
      }
      return (await res.json()) as StandardListPagePage<NotificationRow>;
    },
    [],
  );

  const renderRow = useCallback(
    (row: NotificationRow) => (
      <NotificationDesktopRow row={row} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  const renderCard = useCallback(
    (row: NotificationRow) => (
      <NotificationMobileCard row={row} timePrefs={timePrefs} />
    ),
    [timePrefs],
  );

  return (
    <StandardListPage<NotificationRow, NotificationsFilters>
      entityType="notification"
      queryKey={["notifications-list"]}
      fetchPage={fetchPage}
      filters={filters}
      renderRow={renderRow}
      renderCard={renderCard}
      rowEstimateSize={72}
      cardEstimateSize={112}
      emptyState={
        <StandardEmptyState
          title="No notifications"
          description="Activity from your records will appear here."
        />
      }
      header={{
        title: "Notifications",
        description: "Your recent activity and alerts.",
        fontFamily: "display",
      }}
    />
  );
}

/**
 * Shared inner content: composed title, optional body, timestamp.
 * Never renders the raw `kind`. The whole row is the click target when
 * a `link` is present.
 */
function NotificationContent({
  row,
  timePrefs,
}: {
  row: NotificationRow;
  timePrefs: TimePrefs;
}) {
  return (
    <>
      <p className="text-sm font-medium text-foreground">{row.title}</p>
      {row.body ? (
        <p className="mt-1 text-xs text-muted-foreground">{row.body}</p>
      ) : null}
      <p className="mt-2 text-[10px] text-muted-foreground tabular-nums">
        <UserTimeClient value={row.createdAt} prefs={timePrefs} />
      </p>
    </>
  );
}

function NotificationDesktopRow({
  row,
  timePrefs,
}: {
  row: NotificationRow;
  timePrefs: TimePrefs;
}) {
  const unreadTint = row.isRead ? "" : "bg-primary/5";
  return (
    <div
      className={`border-b border-border bg-card px-4 py-3 ${unreadTint}`}
      data-row-flash="new"
    >
      {row.link ? (
        <Link
          href={row.link}
          className="block rounded-sm transition hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <NotificationContent row={row} timePrefs={timePrefs} />
        </Link>
      ) : (
        <NotificationContent row={row} timePrefs={timePrefs} />
      )}
    </div>
  );
}

function NotificationMobileCard({
  row,
  timePrefs,
}: {
  row: NotificationRow;
  timePrefs: TimePrefs;
}) {
  const unreadTint = row.isRead ? "" : "bg-primary/5";
  return (
    <div
      className={`rounded-md border border-border bg-card p-3 ${unreadTint}`}
      data-row-flash="new"
    >
      {row.link ? (
        <Link
          href={row.link}
          className="block rounded-sm transition hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          <NotificationContent row={row} timePrefs={timePrefs} />
        </Link>
      ) : (
        <NotificationContent row={row} timePrefs={timePrefs} />
      )}
    </div>
  );
}
