"use client";

import { useEffect, useState } from "react";
import { getRealtimeClient } from "@/lib/realtime/client";

/**
 * D365 import run live-progress hook.
 *
 * Subscribes to the Supabase Realtime broadcast channel
 * `d365-import-run:<runId>` (Sub-agent A's `realtime-broadcast.ts`
 * publishes to this channel from the fetch / map / commit phases).
 *
 * Broadcast event names come from `D365_REALTIME_EVENTS`:
 * fetching.started / .progress / .completed
 * mapping.started / .progress / .completed
 * committing.started / .progress / .completed
 * error / halted / resumed
 *
 * Polling fallback: if Realtime is not configured (no Supabase env)
 * OR the channel fails to subscribe within 3s, we fall back to GET
 * /api/admin/d365-import/runs/<runId>/status every 5s.
 *
 * The hook is fire-and-forget — failures log to console.warn but
 * never throw to the consumer.
 */

export type RunRealtimeStatus =
  | "created"
  | "fetching"
  | "mapping"
  | "reviewing"
  | "committing"
  | "paused_for_review"
  | "completed"
  | "aborted";

export interface RunCounters {
  fetched: number;
  mapped: number;
  approved: number;
  rejected: number;
  committed: number;
  skipped: number;
  failed: number;
}

export interface RunLogEntry {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
  at: string; // ISO 8601
}

export interface RunSnapshot {
  status: RunRealtimeStatus;
  currentOperation: string | null;
  counters: RunCounters;
  logs: RunLogEntry[];
  haltReason: string | null;
}

export interface UseRunRealtimeOptions {
  runId: string;
  initial: RunSnapshot;
  /** Polling cadence in ms. Default 5_000. */
  pollMs?: number;
}

interface BroadcastPayload {
  event: string; // e.g. "fetching.progress"
  status?: RunRealtimeStatus;
  currentOperation?: string;
  counters?: Partial<RunCounters>;
  log?: Omit<RunLogEntry, "id" | "at"> & { at?: string; id?: string };
  haltReason?: string | null;
}

const MAX_LOG_ENTRIES = 50;
const SUBSCRIBE_TIMEOUT_MS = 3_000;

export function useRunRealtime({
  runId,
  initial,
  pollMs = 5_000,
}: UseRunRealtimeOptions): RunSnapshot {
  const [snapshot, setSnapshot] = useState<RunSnapshot>(initial);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let subscribeTimeout: ReturnType<typeof setTimeout> | null = null;
    let usingRealtime = false;

    const client = getRealtimeClient();

    function applyPayload(payload: BroadcastPayload) {
      setSnapshot((prev) => {
        const next: RunSnapshot = {
          status: payload.status ?? prev.status,
          currentOperation:
            payload.currentOperation ?? prev.currentOperation ?? null,
          counters: payload.counters
            ? { ...prev.counters, ...payload.counters }
            : prev.counters,
          logs: prev.logs,
          haltReason:
            payload.haltReason !== undefined
              ? payload.haltReason
              : prev.haltReason,
        };
        if (payload.log) {
          const entry: RunLogEntry = {
            id:
              payload.log.id ??
              `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            level: payload.log.level,
            message: payload.log.message,
            detail: payload.log.detail,
            at: payload.log.at ?? new Date().toISOString(),
          };
          next.logs = [entry, ...prev.logs].slice(0, MAX_LOG_ENTRIES);
        }
        return next;
      });
    }

    async function tickPoll() {
      if (cancelled || usingRealtime) return;
      try {
        const res = await fetch(
          `/api/admin/d365-import/runs/${encodeURIComponent(runId)}/status`,
          {
            cache: "no-store",
            credentials: "same-origin",
            headers: { accept: "application/json" },
          },
        );
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) return;
          throw new Error(`status endpoint ${res.status}`);
        }
        const json = (await res.json()) as Partial<RunSnapshot>;
        setSnapshot((prev) => ({
          status: (json.status as RunRealtimeStatus) ?? prev.status,
          currentOperation:
            json.currentOperation ?? prev.currentOperation ?? null,
          counters: { ...prev.counters, ...(json.counters ?? {}) },
          logs: Array.isArray(json.logs) ? json.logs : prev.logs,
          haltReason:
            json.haltReason !== undefined ? json.haltReason : prev.haltReason,
        }));
      } catch (err) {
        // Polling fallback — log and continue. Production code may
        // not have the status endpoint live yet during phased rollout.
        // console.warn is allowed for client-side diagnostic fallbacks
        // (project rule, see CLAUDE.md "Errors and logging").
        console.warn("[d365-import] status poll failed", err);
      } finally {
        if (!cancelled && !usingRealtime) {
          pollTimer = setTimeout(tickPoll, pollMs);
        }
      }
    }

    function startPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(tickPoll, pollMs);
    }

    if (!client) {
      // No Supabase env — straight to polling.
      startPolling();
      return () => {
        cancelled = true;
        if (pollTimer) clearTimeout(pollTimer);
      };
    }

    const channelName = `d365-import-run:${runId}`;
    const channel = client.channel(channelName, {
      config: { broadcast: { self: false } },
    });

    channel.on("broadcast", { event: "*" }, (msg: { event: string; payload: unknown }) => {
      const payload = msg.payload as BroadcastPayload | undefined;
      if (!payload) return;
      // The broadcast helper stamps the event name on the envelope —
      // mirror it into payload.event for downstream readers.
      applyPayload({ ...payload, event: msg.event });
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        usingRealtime = true;
        if (subscribeTimeout) clearTimeout(subscribeTimeout);
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        // Channel never subscribed (e.g. token mint failed) — fall
        // back to polling so the panel still updates.
        usingRealtime = false;
        startPolling();
      }
    });

    // Belt-and-braces: if `subscribe` callback never fires within 3s,
    // assume failure and start polling. The callback will flip
    // usingRealtime back to true if it eventually succeeds.
    subscribeTimeout = setTimeout(() => {
      if (!usingRealtime && !cancelled) startPolling();
    }, SUBSCRIBE_TIMEOUT_MS);

    return () => {
      cancelled = true;
      if (subscribeTimeout) clearTimeout(subscribeTimeout);
      if (pollTimer) clearTimeout(pollTimer);
      client.removeChannel(channel);
    };
  }, [runId, pollMs]);

  return snapshot;
}
