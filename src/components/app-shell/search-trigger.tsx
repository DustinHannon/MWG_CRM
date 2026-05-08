"use client";

import { Search } from "lucide-react";

/**
 * Visible Cmd+K affordance. Lives in the top bar so users who don't
 * know the keyboard shortcut still have a discoverable click target.
 *
 * Mechanism: dispatches `mwg:command-palette-open` on the window;
 * `CommandPalette` listens for it and sets its open state to true.
 *
 * Renders the keyboard hint inline at md+ breakpoints; collapses to
 * icon-only on mobile where the kbd glyph would crowd.
 */
export function SearchTrigger() {
  function handleClick() {
    window.dispatchEvent(new Event("mwg:command-palette-open"));
  }

  // Detect platform once on first render — Mac shows ⌘, others Ctrl.
  // SSR returns Ctrl by default; the client effect would correct, but
  // the visible kbd text is purely cosmetic so it's fine either way.
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
  const modifier = isMac ? "⌘" : "Ctrl";

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Open search (Ctrl+K)"
      title="Search · Ctrl+K"
      className="inline-flex h-9 items-center gap-2 rounded-md border border-glass-border bg-card/40 px-2.5 text-sm text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
    >
      <Search size={16} aria-hidden />
      <span className="hidden sm:inline">Search</span>
      <kbd className="ml-1 hidden rounded bg-input/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none text-muted-foreground md:inline-flex">
        {modifier} K
      </kbd>
    </button>
  );
}
