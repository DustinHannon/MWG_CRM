"use client";

import Link from "next/link";
import { useCallback, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  StandardEmptyState,
  StandardListPage,
  type StandardListPagePage,
} from "@/components/standard";
import { ActivityPill } from "@/components/ui/activity-pill";
import { UserTimeClient } from "@/components/ui/user-time-client";
import { type TimePrefs } from "@/lib/format-time";
import { restoreFromNotificationAction } from "@/components/notifications/actions";

/**
 * Row shape served by /api/notifications/list (createdAt is an ISO
 * string over the wire). The raw `kind` is exposed only because the
 * client dispatches the actionable Restore button on
 * kind === "archive_pending"; it is NEVER rendered as raw copy — the
 * row self-describes via the composed `title`.
 */
export interface NotificationRow {
  id: string;
  /**
   * Internal discriminator — never shown as raw copy; used to render
   * the Restore button on archive_pending rows.
   */
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  /** ActivityVerb for kind="activity" rows; null for other kinds. */
  verb: string | null;
  /** Entity discriminator for actionable rows. */
  entityType: string | null;
  /** Entity id for actionable rows. */
  entityId: string | null;
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
  // Activity rows carry a verb; render it as a colored pill (same
  // look as the status/priority pills on the other list pages) and
  // strip the leading verb word from the composed title so it isn't
  // repeated. Non-activity kinds (verb null) render unchanged.
  const titleText =
    row.verb && row.title.startsWith(`${row.verb} `)
      ? row.title.slice(row.verb.length + 1)
      : row.title;
  return (
    <>
      {row.verb ? (
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ActivityPill verb={row.verb} className="shrink-0" />
          <span className="min-w-0 truncate">{titleText}</span>
        </p>
      ) : (
        <p className="text-sm font-medium text-foreground">{titleText}</p>
      )}
      {row.body ? (
        <p className="mt-1 text-xs text-muted-foreground">{row.body}</p>
      ) : null}
      <p className="mt-2 text-[10px] text-muted-foreground tabular-nums">
        <UserTimeClient value={row.createdAt} prefs={timePrefs} />
      </p>
    </>
  );
}

/**
 * Restore button for an actionable `archive_pending` row. Dispatches
 * restoreFromNotificationAction with the snapshotted entityType +
 * entityId. The server action runs the same canDelete<E> gate as the
 * per-entity restoreXAction (single code path, two entry points) and
 * marks the notification is_read = true on success — we mirror the
 * read state locally via `isResolved` so the button shows "Restored"
 * until the list re-fetches.
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
      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-foreground transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {pending ? "Restoring…" : "Restore"}
    </button>
  );
}

/**
 * Renders the Restore button when the row is an actionable
 * archive_pending prompt. Rendered OUTSIDE the wrapping <Link> on
 * each row so the button's click doesn't navigate.
 */
function RowActions({ row }: { row: NotificationRow }) {
  if (
    row.kind === "archive_pending" &&
    row.entityType &&
    row.entityId
  ) {
    return (
      <RestoreNotificationButton
        notificationId={row.id}
        entityType={row.entityType}
        entityId={row.entityId}
        isResolved={row.isRead}
      />
    );
  }
  return null;
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
      <RowActions row={row} />
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
      <RowActions row={row} />
    </div>
  );
}
