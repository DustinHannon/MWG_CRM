"use client";

import {
  useRealtimePoll,
  type RealtimeEntity,
} from "@/hooks/realtime/use-realtime-poll";

/**
 * Phase 11 — small client wrapper that mounts the realtime poller for
 * a page. Pages render this once at the top of their client subtree;
 * the hook's effect handles the rest.
 *
 *   <PagePoll entities={["leads"]} />
 *
 * Default behavior is `router.refresh()` on any change. Pages that
 * want richer behavior (e.g., partial cache updates, custom toast)
 * can pass their own `onChange` handler — but that's rare and the
 * server-rendering pattern means refresh is usually the right answer.
 */
export function PagePoll({ entities }: { entities: RealtimeEntity[] }) {
  useRealtimePoll({ entities });
  return null;
}
