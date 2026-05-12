"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface LockHolder {
  userId: string;
  userName: string;
  acquiredAt: Date;
}

export type LockStatus = "idle" | "acquiring" | "held" | "locked";

interface UseTemplateLockResult {
  status: LockStatus;
  holder: LockHolder | null;
  error: string | null;
  releaseLock: () => Promise<void>;
}

/**
 * Client hook for the marketing-template soft-lock.
 *
 * Behavior:
 * 1. On mount, mints a per-tab `sessionId` (kept stable across the
 * hook's lifetime via `useRef`) and POSTs `/lock`.
 * • 200 → status='held'
 * • 409 with `{ holder }` → status='locked'
 * 2. While 'held', PUTs the heartbeat every 30s.
 * 3. On unmount and on `beforeunload`, sends a DELETE so the next
 * editor can pick up immediately. The unload path uses
 * `fetch(..., { keepalive: true })` instead of sendBeacon so we
 * can ship a JSON body with the sessionId.
 *
 * The realtime broadcast channel that would push lock changes to other
 * tabs is deferred to a follow-up phase — for now another editor sees
 * the lock the next time they open the page.
 */
export function useTemplateLock(templateId: string): UseTemplateLockResult {
  // Mint (or reuse) a per-tab sessionId. The id is stashed in
  // `sessionStorage` keyed by template id so a sibling component on
  // the same page (e.g. the save handler in `template-editor.tsx`)
  // can pick it up and present it to server actions that need to
  // assert "I am the lock holder".
  //
  // We mint inside `useState`'s lazy initializer so the impure
  // calls (`crypto.randomUUID`, `sessionStorage.getItem`) run once
  // per mount instead of on every render — React's rules-of-hooks
  // model treats lazy initializers as the canonical "first-render
  // only" hook for this kind of value.
  const storageKey = `mwg-tpl-lock:${templateId}`;
  const [sessionId] = useState<string>(() => {
    if (typeof window === "undefined") {
      // SSR shouldn't reach here (the hook is only called from a
      // 'use client' component) but guard anyway so the initializer
      // can never throw.
      return "ssr";
    }
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const minted =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `s_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    window.sessionStorage.setItem(storageKey, minted);
    return minted;
  });
  // Initial status is `acquiring` because the effect below begins
  // its POST as soon as the component mounts. Setting state
  // synchronously inside the effect itself would trigger a cascading
  // render — react-hooks/set-state-in-effect catches that.
  const [status, setStatus] = useState<LockStatus>("acquiring");
  const [holder, setHolder] = useState<LockHolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heldRef = useRef(false);

  const lockUrl = `/api/v1/marketing/templates/${templateId}/lock`;

  const releaseLock = useCallback(async () => {
    if (!heldRef.current) return;
    heldRef.current = false;
    try {
      await fetch(lockUrl, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId }),
        keepalive: true,
      });
    } catch {
      // Best-effort release. Stale rows expire via the timeout sweep.
    }
  }, [lockUrl, sessionId]);

  useEffect(() => {
    let cancelled = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const acquire = async () => {
      try {
        const res = await fetch(lockUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId }),
        });
        if (cancelled) return;
        if (res.status === 200) {
          heldRef.current = true;
          setHolder(null);
          setStatus("held");
          heartbeatTimer = setInterval(() => {
            void fetch(lockUrl, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: sessionId }),
            }).catch(() => {
              // Best-effort. Server prunes stale rows on next acquire.
            });
          }, 30_000);
          return;
        }
        if (res.status === 409) {
          const body = (await res.json().catch(() => null)) as {
            holder?: { userId: string; userName: string; acquiredAt: string };
          } | null;
          if (body?.holder) {
            setHolder({
              userId: body.holder.userId,
              userName: body.holder.userName,
              acquiredAt: new Date(body.holder.acquiredAt),
            });
          }
          setStatus("locked");
          return;
        }
        setError(`Failed to acquire lock (${res.status})`);
        setStatus("idle");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to acquire lock");
        setStatus("idle");
      }
    };

    void acquire();

    const handleUnload = () => {
      if (!heldRef.current) return;
      // keepalive=true lets the request fly while the page tears down.
      try {
        void fetch(lockUrl, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId }),
          keepalive: true,
        });
      } catch {
        // Best-effort.
      }
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", handleUnload);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (heldRef.current) {
        heldRef.current = false;
        // Fire-and-forget; component is going away.
        void fetch(lockUrl, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: sessionId }),
          keepalive: true,
        }).catch(() => {
          // Best-effort.
        });
      }
    };
  }, [lockUrl, sessionId]);

  return { status, holder, error, releaseLock };
}
