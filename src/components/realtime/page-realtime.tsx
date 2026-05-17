"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";
import { useTableSubscription } from "@/hooks/realtime/use-table-subscription";
import type { RealtimeEntity } from "@/hooks/realtime/use-realtime-poll";

/**
 * Supabase Realtime wrapper for list/detail pages. Drop-in
 * companion to the <PagePoll> with the same entity-name surface.
 *
 * <PageRealtime entities={["leads"]} />
 *
 * Behavior: on any INSERT / UPDATE / DELETE that the realtime broker
 * delivers to this client (RLS-scoped), we call `router.refresh()` so
 * the server component re-renders with fresh data. Skip-self is enforced
 * by the hook (default `true`) so the actor's own writes don't echo
 * back — overridable per mount via `skipSelf`. The layout's
 * user_id-filtered notifications subscription passes `skipSelf={false}`
 * because every event on that channel is, by the filter, the viewer's
 * own and SHOULD live-update the bell.
 *
 * The polling layer (PagePoll) stays as the documented fallback; Sub-A
 * will trim duplicates if a page mounts both. Sub-A may also drop
 * <PagePoll> on pages that have <PageRealtime> after a brief soak.
 */

// Map the cross-cutting entity name (used by PagePoll) to the actual
// SQL table name. The realtime publication is on these table names.
const ENTITY_TO_TABLE: Record<RealtimeEntity, string> = {
  leads: "leads",
  accounts: "crm_accounts", // SQL table is `crm_accounts`, not `accounts`
  contacts: "contacts",
  opportunities: "opportunities",
  tasks: "tasks",
  activities: "activities",
  notifications: "notifications",
};

interface PageRealtimeProps {
  entities: RealtimeEntity[];
  /**
   * Optional filter, applied to all subscribed tables. Use sparingly —
   * Postgres-changes filter syntax is `<column>=eq.<value>`. For a
   * detail page subscribing to a parent record's activities, prefer
   * <PageRealtime entities={["activities"]} filter={`lead_id=eq.${leadId}`} />.
   */
  filter?: string;
  /**
   * Forwarded to `useTableSubscription`. Defaults to `true` (the hook's
   * default — the actor's own writes don't echo back). Pass `false`
   * ONLY for a subscription whose `filter` already scopes every event
   * to the viewer (e.g. the layout's `user_id=eq.${viewer}`
   * notifications channel), where a self-event IS legitimately the
   * viewer's and must live-update.
   */
  skipSelf?: boolean;
}

export function PageRealtime({
  entities,
  filter,
  skipSelf,
}: PageRealtimeProps) {
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Coalesce rapid bursts so we only fire one refresh per ~150ms.
  const handleChange = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      router.refresh();
    }, 150);
  }, [router]);

  return (
    <>
      {entities.map((entity) => (
        <TableSubscriber
          key={`${entity}:${filter ?? ""}`}
          table={ENTITY_TO_TABLE[entity]}
          filter={filter}
          skipSelf={skipSelf}
          onChange={handleChange}
        />
      ))}
    </>
  );
}

interface TableSubscriberProps {
  table: string;
  filter?: string;
  skipSelf?: boolean;
  onChange: () => void;
}

/**
 * Internal — one subscription per mount. React's rules-of-hooks require
 * a stable hook count, so PageRealtime renders one of these per entity
 * rather than calling useTableSubscription in a loop.
 */
function TableSubscriber({
  table,
  filter,
  skipSelf,
  onChange,
}: TableSubscriberProps) {
  // skipSelf undefined (the common case) ⇒ useTableSubscription's
  // `skipSelf = true` destructuring default applies — behavior
  // unchanged for every existing caller.
  useTableSubscription({ table, filter, skipSelf, onChange });
  return null;
}
