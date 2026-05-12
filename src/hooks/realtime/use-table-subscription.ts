"use client";

import { useEffect, useRef } from "react";
import { getRealtimeClient } from "@/lib/realtime/client";
import { useRealtimeViewer } from "@/components/realtime/realtime-provider";

export type RealtimeOp = "INSERT" | "UPDATE" | "DELETE";

export interface RealtimeChange<T> {
  op: RealtimeOp;
  /** New row state (null on DELETE). */
  new: T | null;
  /** Old row state (null on INSERT; populated on UPDATE/DELETE because we set REPLICA IDENTITY FULL on the publication). */
  old: T | null;
  table: string;
}

interface SubscriptionOptions<T> {
  /** SQL table name in the public schema, e.g. "leads", "crm_accounts". */
  table: string;
  /** Optional Postgres-format filter, e.g. `id=eq.${someId}` or `lead_id=eq.${parentId}`. */
  filter?: string;
  onChange: (change: RealtimeChange<T>) => void;
  /**
   * If true, ignore events whose actor is the current viewer. Default: true.
   * Override by setting `localStorage._e2eDisableSkipSelf = 'true'` (used
   * by Playwright tests where both contexts share an account).
   */
  skipSelf?: boolean;
}

// Supabase Realtime payload shape for postgres_changes events.
type SupabasePostgresChange = {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  schema: string;
  table: string;
  commit_timestamp?: string;
};

/**
 * Supabase Realtime subscription hook.
 *
 * Wires a Postgres-changes channel on `public.<table>` (optionally
 * filtered) into a stable callback. Cleans up on unmount. Respects
 * skip-self by inspecting the actor stamping columns on the row.
 */
export function useTableSubscription<T extends { id: string }>({
  table,
  filter,
  onChange,
  skipSelf = true,
}: SubscriptionOptions<T>): void {
  const cb = useRef(onChange);
  const { userId } = useRealtimeViewer();

  // Keep latest callback in a ref so we don't tear down the channel
  // when the consumer's handler closure changes.
  useEffect(() => {
    cb.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const client = getRealtimeClient();
    if (!client) return;

    const channelName = `tbl:${table}${filter ? `:${filter}` : ""}:${userId}`;
    const escapeHatch =
      typeof window !== "undefined" &&
      window.localStorage?.getItem("_e2eDisableSkipSelf") === "true";

    const channel = client
      .channel(channelName)
      .on(
        "postgres_changes" as never,
        { event: "*", schema: "public", table, filter } as never,
        (msg: SupabasePostgresChange) => {
          const op = msg.eventType;
          const newRow = (msg.new ?? null) as T | null;
          const oldRow = (msg.old ?? null) as T | null;

          if (skipSelf && !escapeHatch && userId) {
            const actorId = actorOf(newRow) ?? actorOf(oldRow);
            if (actorId && actorId === userId) return;
          }

          cb.current({ op, new: newRow, old: oldRow, table });
        },
      )
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, [table, filter, userId, skipSelf]);
}

function actorOf<T>(row: T | null): string | null {
  if (!row) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.updated_by_id === "string") return r.updated_by_id;
  if (typeof r.created_by_id === "string") return r.created_by_id;
  if (typeof r.user_id === "string") return r.user_id;
  return null;
}

/**
 * Convenience wrapper for single-row subscription on a detail page.
 *
 * Equivalent to `useTableSubscription({ table, filter: 'id=eq.<id>', onChange })`.
 */
export function useRowSubscription<T extends { id: string }>({
  table,
  id,
  onChange,
  skipSelf = true,
}: {
  table: string;
  id: string;
  onChange: (change: RealtimeChange<T>) => void;
  skipSelf?: boolean;
}): void {
  useTableSubscription<T>({
    table,
    filter: `id=eq.${id}`,
    onChange,
    skipSelf,
  });
}
