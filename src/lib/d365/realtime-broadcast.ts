import "server-only";

import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import type { D365RealtimeEvent } from "./audit-events";

/**
 * Phase 23 — server-side broadcast helper for the
 * `d365-import-run:<runId>` Supabase Realtime channel.
 *
 * Browser subscribers receive these events via the Phase 12 realtime
 * client and update the live progress panel without page reload.
 *
 * Failure mode: best-effort, like `writeAudit`. A broadcast failure
 * MUST NOT block the caller — the orchestrator owns the persisted
 * source of truth (import_runs / import_batches / import_records),
 * realtime is purely a UX optimization. We log the failure and
 * return.
 *
 * Env wiring:
 *   - `SUPABASE_URL`              — required (server-side, no NEXT_PUBLIC).
 *     Falls back to `NEXT_PUBLIC_SUPABASE_URL` if not set.
 *   - `SUPABASE_SERVICE_ROLE_KEY` — preferred. Bypasses RLS so the
 *     publisher can broadcast even without a per-user JWT.
 *     Falls back to `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the anon key has
 *     publish-only permission on broadcast channels by default —
 *     verify in Supabase if RLS is tightened later).
 *
 * If neither URL+key combo is present, calls become no-ops and we log
 * a one-time `d365.broadcast.disabled` warning.
 */

let cached: SupabaseClient | null | undefined; // undefined = not yet probed

function getServerClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    logger.warn("d365.broadcast.disabled", {
      reason: "missing_env",
      hasUrl: Boolean(url),
      hasKey: Boolean(key),
    });
    cached = null;
    return null;
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return cached;
}

/**
 * Broadcast a single event on the per-run channel. Fire-and-forget
 * semantics; resolves once the message is acknowledged by Supabase
 * realtime (or the local stub no-ops).
 *
 * NOTE: We send via a transient channel each call rather than caching
 * a long-lived channel because import runs are short-lived (minutes
 * not hours) and the orchestrator runs in a Vercel function whose
 * lifecycle ends immediately after the response. A cached channel
 * would risk leaking sockets across warm starts.
 */
export async function broadcastRunEvent(
  runId: string,
  event: D365RealtimeEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const client = getServerClient();
  if (!client) return; // disabled, already logged once at probe time

  const topic = `d365-import-run:${runId}`;
  const channel = client.channel(topic, {
    config: { broadcast: { self: false, ack: true } },
  });

  try {
    await new Promise<void>((resolve) => {
      // `subscribe` callback runs once we're attached. Send the broadcast
      // and tear the channel down. Wrapped in a 5s safety timeout so a
      // network blip doesn't stall the server action.
      const timer = setTimeout(() => {
        logger.warn("d365.broadcast.timeout", { runId, event });
        resolve();
      }, 5000);

      channel.subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        try {
          await channel.send({
            type: "broadcast",
            event,
            payload: { runId, event, ts: new Date().toISOString(), ...payload },
          });
        } catch (err) {
          logger.error("d365.broadcast.send_failed", {
            runId,
            event,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        } finally {
          clearTimeout(timer);
          // Removal is also fire-and-forget; we don't await it because
          // the run may have already moved on and we don't want to
          // hold up the orchestrator on a teardown round-trip.
          void client.removeChannel(channel);
          resolve();
        }
      });
    });
  } catch (err) {
    // Per the contract: log + swallow.
    logger.error("d365.broadcast.failed", {
      runId,
      event,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

