"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export type RealtimeEntity =
  | "leads"
  | "accounts"
  | "contacts"
  | "opportunities"
  | "tasks"
  | "activities"
  | "notifications";

interface PollOptions {
  /** Subset of entities to poll. Default: caller must pass at least one. */
  entities: RealtimeEntity[];
  /** Visible focused-tab cadence, default 10s. */
  activeMs?: number;
  /** Visible unfocused-tab cadence, default 30s. */
  idleMs?: number;
  /** After two empty responses, slow to this cadence (default 60s). */
  backoffMs?: number;
  /**
   * Optional callback fired with the changed-id sets when the response
   * carries new data. Default: just `router.refresh()`.
   */
  onChange?: (changes: Partial<Record<RealtimeEntity, string[]>>) => void;
}

interface ChangesResponse {
  entities: Partial<Record<RealtimeEntity, string[]>>;
  lastChangeAt: string;
}

/**
 * Phase 11 — polling-based realtime. See PHASE11-AUDIT.md §3 for why
 * we don't ship Supabase channels in v1.
 *
 * Loop:
 *   1. Initial fetch sets `since` to "now".
 *   2. Every tick, GET /api/realtime/changes?entities=..&since=<iso>.
 *   3. If response carries any ids: call onChange(or router.refresh)
 *      and update `since` to lastChangeAt.
 *   4. If two consecutive ticks are empty, slow to backoffMs.
 *   5. visibilitychange → adjust cadence; "hidden" pauses entirely.
 *   6. window:focus + window:mwg:refresh-now → reset cadence + tick.
 *
 * The hook is fire-and-forget — failure modes log to console.warn but
 * never throw to the consumer. The page degrades gracefully to "data
 * is stale until the user refreshes."
 */
export function useRealtimePoll(opts: PollOptions): void {
  const router = useRouter();
  const since = useRef(new Date().toISOString());
  const emptyStreak = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aborter = useRef<AbortController | null>(null);

  const onChangeRef = useRef(opts.onChange);
  // Sync the latest callback into the ref outside of render so the
  // closure inside the polling loop can pick up new handlers without
  // restarting the timer.
  useEffect(() => {
    onChangeRef.current = opts.onChange;
  }, [opts.onChange]);

  useEffect(() => {
    const activeMs = opts.activeMs ?? 10_000;
    const idleMs = opts.idleMs ?? 30_000;
    const backoffMs = opts.backoffMs ?? 60_000;
    const entitiesParam = opts.entities.join(",");

    const cadence = () => {
      if (typeof document === "undefined") return idleMs;
      if (document.visibilityState === "hidden") return null; // paused
      const focused = document.hasFocus();
      const base = focused ? activeMs : idleMs;
      return emptyStreak.current >= 2 ? Math.max(base, backoffMs) : base;
    };

    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      const delay = cadence();
      if (delay === null) return; // hidden — wait for visibilitychange
      timer.current = setTimeout(tick, delay);
    };

    const tick = async () => {
      aborter.current?.abort();
      const ac = new AbortController();
      aborter.current = ac;
      try {
        const url = `/api/realtime/changes?entities=${encodeURIComponent(
          entitiesParam,
        )}&since=${encodeURIComponent(since.current)}`;
        const res = await fetch(url, {
          signal: ac.signal,
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          // 401: user signed out elsewhere. Stop polling — the next
          // navigation will redirect to /auth/signin.
          if (res.status === 401) return;
          throw new Error(`changes endpoint returned ${res.status}`);
        }
        const json = (await res.json()) as ChangesResponse;
        const anyChanges = Object.values(json.entities ?? {}).some(
          (arr) => Array.isArray(arr) && arr.length > 0,
        );
        if (anyChanges) {
          emptyStreak.current = 0;
          since.current = json.lastChangeAt || new Date().toISOString();
          if (onChangeRef.current) {
            onChangeRef.current(json.entities);
          } else {
            router.refresh();
          }
        } else {
          emptyStreak.current += 1;
          since.current = json.lastChangeAt || since.current;
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        console.warn("realtime-poll tick failed", err);
        emptyStreak.current += 1;
      } finally {
        schedule();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        emptyStreak.current = 0;
        tick();
      } else {
        if (timer.current) clearTimeout(timer.current);
        aborter.current?.abort();
      }
    };

    const onFocus = () => {
      emptyStreak.current = 0;
      tick();
    };

    const onForceRefresh = () => {
      emptyStreak.current = 0;
      since.current = new Date(Date.now() - 30_000).toISOString();
      tick();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("mwg:refresh-now", onForceRefresh);

    schedule();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("mwg:refresh-now", onForceRefresh);
      if (timer.current) clearTimeout(timer.current);
      aborter.current?.abort();
    };
    // entitiesParam captures opts.entities; cadence values are read
    // from the closure on each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.entities.join(","), opts.activeMs, opts.idleMs, opts.backoffMs]);
}
