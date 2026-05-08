"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";
import { useTableSubscription } from "@/hooks/realtime/use-table-subscription";
import type { RealtimeEntity } from "@/hooks/realtime/use-realtime-poll";

/**
 * Phase 12 — Supabase Realtime wrapper for list/detail pages. Drop-in
 * companion to Phase 11's <PagePoll> with the same entity-name surface.
 *
 *   <PageRealtime entities={["leads"]} />
 *
 * Behavior: on any INSERT / UPDATE / DELETE that the realtime broker
 * delivers to this client (RLS-scoped), we call `router.refresh()` so
 * the server component re-renders with fresh data. Skip-self is enforced
 * by the hook so the actor's own writes don't echo back.
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
}

export function PageRealtime({ entities, filter }: PageRealtimeProps) {
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
          onChange={handleChange}
        />
      ))}
    </>
  );
}

interface TableSubscriberProps {
  table: string;
  filter?: string;
  onChange: () => void;
}

/**
 * Internal — one subscription per mount. React's rules-of-hooks require
 * a stable hook count, so PageRealtime renders one of these per entity
 * rather than calling useTableSubscription in a loop.
 */
function TableSubscriber({ table, filter, onChange }: TableSubscriberProps) {
  useTableSubscription({ table, filter, onChange });
  return null;
}
