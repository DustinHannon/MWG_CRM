"use client";

import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

/**
 * Phase 12 — Supabase Realtime client (browser-only).
 *
 * The CRM does NOT use Supabase Auth. We mint our own HS256 JWTs from
 * `/api/auth/realtime-token` and feed them to this client via
 * `client.realtime.setAuth(token)` so the realtime broker can apply the
 * RLS policies that read user_id / is_admin / can_view_all from the
 * JWT claims.
 *
 * All server-side database access remains Drizzle + postgres-js with the
 * BYPASSRLS app role. This client is exclusively for the realtime
 * channel.
 *
 * Singleton because Realtime channels are per-client; we want one socket
 * per page session.
 */
let cached: SupabaseClient | null = null;

export function getRealtimeClient(): SupabaseClient | null {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    // Realtime not configured (e.g., dev without Supabase env vars). The
    // hooks will degrade gracefully — they short-circuit on a null client
    // and the existing Phase 11 polling layer continues to drive
    // freshness via router.refresh().
    return null;
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return cached;
}

