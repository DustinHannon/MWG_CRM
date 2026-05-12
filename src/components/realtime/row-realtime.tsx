"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";
import { useRowSubscription } from "@/hooks/realtime/use-table-subscription";
import type { RealtimeEntity } from "@/hooks/realtime/use-realtime-poll";

/**
 * single-row Supabase Realtime subscription for detail
 * pages. On any UPDATE/DELETE of the focal record, we call
 * `router.refresh()` (debounced 150ms) so the server-rendered detail
 * surface re-renders with fresh data. Skip-self is enforced inside
 * the hook so the actor's own writes don't echo back.
 *
 * <RowRealtime entity="leads" id={lead.id} />
 *
 * Pair with `<PageRealtime entities={["activities", …]} filter=… />`
 * for the timeline + child tables.
 */

const ENTITY_TO_TABLE: Record<RealtimeEntity, string> = {
  leads: "leads",
  accounts: "crm_accounts",
  contacts: "contacts",
  opportunities: "opportunities",
  tasks: "tasks",
  activities: "activities",
  notifications: "notifications",
};

interface RowRealtimeProps {
  entity: RealtimeEntity;
  id: string;
}

export function RowRealtime({ entity, id }: RowRealtimeProps) {
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      router.refresh();
    }, 150);
  }, [router]);

  useRowSubscription({
    table: ENTITY_TO_TABLE[entity],
    id,
    onChange: handleChange,
  });

  return null;
}
