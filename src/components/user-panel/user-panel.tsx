"use client";

import { ChevronUp, Lock, LogOut, Settings as SettingsIcon } from "lucide-react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface UserPanelProps {
  userId: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
  photoUrl: string | null;
  /** Sidebar collapse state — when true, render avatar-only mode. */
  collapsed?: boolean;
}

/**
 * Phase 3B replaces the Phase 1/2 static identity block at the bottom
 * of the sidebar with a single clickable card. Clicking opens a popover
 * above the trigger with TWO items: Settings and Sign out.
 *
 * Native button → keyboard, screen-reader, focus-ring all come for free.
 * Theme toggle is NOT here — moved to /settings.
 */
export function UserPanel({
  userId,
  displayName,
  email,
  jobTitle,
  photoUrl,
  collapsed = false,
}: UserPanelProps) {
  const [open, setOpen] = useState(false);
  const subtitle = jobTitle ?? email;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${displayName} — open user menu`}
          className={cn(
            "group flex w-full items-center gap-3 rounded-lg p-2.5 text-left",
            "glass-surface glass-surface--2 glass-surface--interactive",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            collapsed && "justify-center p-2",
          )}
        >
          <Avatar
            src={photoUrl}
            name={displayName}
            id={userId}
            size={collapsed ? 36 : 36}
          />
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold leading-tight text-foreground">
                  {displayName}
                </span>
                <span className="mt-0.5 block truncate text-xs leading-tight text-muted-foreground">
                  {subtitle}
                </span>
              </span>
              <ChevronUp
                size={16}
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform duration-150",
                  open ? "rotate-0" : "rotate-180",
                )}
                aria-hidden
              />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="w-[280px] p-0"
      >
        {/* Header */}
        <div className="flex items-center gap-3 p-4">
          <Avatar src={photoUrl} name={displayName} id={userId} size={48} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">
              {displayName}
            </p>
            <p className="mt-0.5 truncate text-xs leading-tight text-muted-foreground">
              {email}
            </p>
          </div>
        </div>

        <div className="h-px bg-glass-border" />

        {/* Menu items */}
        <div className="p-1.5">
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-accent/40 focus:bg-accent/40 focus:outline-none"
          >
            <SettingsIcon size={16} aria-hidden />
            <span>Settings</span>
          </Link>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void signOut({ callbackUrl: "/auth/signin" });
            }}
            className="mt-0.5 flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm text-destructive transition-colors hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
          >
            <LogOut size={16} aria-hidden />
            <span>Sign out</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

