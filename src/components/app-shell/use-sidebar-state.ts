"use client";

import { useCallback, useState } from "react";

/**
 * client hook that owns the desktop sidebar collapse
 * state. Initial value comes from the server (read off
 * `user_preferences.sidebar_collapsed` in the AppShell server
 * component). Toggling fires a fire-and-forget PATCH to
 * `/api/me/preferences` so the choice persists across sessions and
 * devices. The optimistic UI flip is applied first; if the server
 * rejects the patch we silently revert.
 *
 * The mobile drawer ignores this state — at <1024px the slide-out
 * drawer is the only navigation surface (work).
 */
export function useSidebarState(initial: boolean) {
  const [collapsed, setCollapsed] = useState<boolean>(initial);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      void persist(next).catch(() => {
        // On failure revert silently — the sidebar is a low-stakes
        // preference. Next page load will re-read from the DB and
        // self-heal.
        setCollapsed(prev);
      });
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

async function persist(next: boolean): Promise<void> {
  const res = await fetch("/api/me/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sidebar_collapsed: next }),
  });
  if (!res.ok) throw new Error(`PATCH /api/me/preferences ${res.status}`);
}
