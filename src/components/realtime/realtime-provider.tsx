"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { getRealtimeClient } from "@/lib/realtime/client";

interface RealtimeContextValue {
  /** Current user id (from session). Used for skip-self in the hooks. */
  userId: string;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const TOKEN_REFRESH_LEAD_SECONDS = 300; // refresh 5 min before expiry
const RETRY_BACKOFF_MS = 30_000;

interface RealtimeProviderProps {
  userId: string;
  children: React.ReactNode;
}

/**
 * mounts at the top of the authenticated layout. Fetches a
 * Supabase JWT minted from the user's session, hands it to the realtime
 * client, and refreshes before expiry.
 *
 * Failure modes:
 * JWT mint endpoint 401 → user signed out elsewhere; provider goes
 * quiet and the next navigation will redirect to /auth/signin.
 * JWT mint endpoint 5xx / 503 → log + retry every 30s. Realtime stays
 * inert until recovery; the existing polling fallback still produces
 * fresh data via router.refresh().
 * NEXT_PUBLIC_SUPABASE_* missing → getRealtimeClient() returns null;
 * we skip the whole flow.
 */
export function RealtimeProvider({ userId, children }: RealtimeProviderProps) {
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = getRealtimeClient();
    if (!client) {
      // Realtime not configured. Hooks short-circuit on null client.
      return;
    }

    async function refresh() {
      try {
        const res = await fetch("/api/auth/realtime-token", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (res.status === 401) {
            // Session gone. Stop trying.
            return;
          }
          throw new Error(`token fetch ${res.status}`);
        }
        const { token, expiresIn } = (await res.json()) as {
          token: string;
          expiresIn: number;
        };
        if (cancelled) return;
        await client!.realtime.setAuth(token);
        const nextMs =
          Math.max(60, expiresIn - TOKEN_REFRESH_LEAD_SECONDS) * 1000;
        refreshTimer.current = setTimeout(refresh, nextMs);
      } catch (err) {
        console.warn("[realtime] token refresh failed; retrying", err);
        if (cancelled) return;
        refreshTimer.current = setTimeout(refresh, RETRY_BACKOFF_MS);
      }
    }

    refresh();

    return () => {
      cancelled = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  return (
    <RealtimeContext.Provider value={{ userId }}>
      {children}
    </RealtimeContext.Provider>
  );
}

/**
 * Internal hook used by the realtime subscription hooks. Returns the
 * current viewer's id so they can implement skip-self.
 */
export function useRealtimeViewer(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error(
      "Realtime hooks must be used inside <RealtimeProvider>. " +
        "Mount it in the authenticated app layout.",
    );
  }
  return ctx;
}
