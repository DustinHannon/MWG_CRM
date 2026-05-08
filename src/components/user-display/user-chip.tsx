"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { resolveName, UserAvatar, type UserAvatarSize, type UserAvatarUserShape } from "./user-avatar";

interface UserChipProps {
  user: UserAvatarUserShape;
  /** Avatar size — controls the chip's vertical scale. */
  size?: UserAvatarSize;
  /**
   * The hover-card body. Pass a server-rendered <UserHoverCard userId={...} />
   * from the parent so this client component never reaches the DB.
   * Optional — when omitted, the chip is just an avatar+name link.
   */
  hoverCard?: React.ReactNode;
  /** Hide the name label (avatar-only mode for tight spaces). */
  avatarOnly?: boolean;
  className?: string;
}

/**
 * Phase 9B canonical user chip. Avatar + display name, links to
 * /users/[id] on click. When `hoverCard` is supplied, hovering the chip
 * (or focusing it via keyboard) opens a popover with the rich preview.
 *
 * Implementation notes:
 *   - Built on the existing Radix Popover primitive (matches the
 *     project's hover patterns; keyboard + screen reader friendly).
 *     Native <details>/<summary> would lose keyboard parity with the
 *     rest of the app's chrome.
 *   - We use Popover not HoverCard because shadcn/Radix HoverCard isn't
 *     yet vendored in this repo. Same UX: opens on pointer enter, closes
 *     on pointer leave + outside click.
 *   - openDelay 200ms so accidental cursor flyovers don't fire.
 */
export function UserChip({
  user,
  size = "sm",
  hoverCard,
  avatarOnly,
  className,
}: UserChipProps) {
  const [open, setOpen] = useState(false);
  const name = resolveName(user);
  const trigger = (
    <Link
      href={`/users/${user.id}`}
      onMouseEnter={hoverCard ? () => setOpen(true) : undefined}
      onMouseLeave={hoverCard ? () => setOpen(false) : undefined}
      onFocus={hoverCard ? () => setOpen(true) : undefined}
      onBlur={hoverCard ? () => setOpen(false) : undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-md hover:underline",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <UserAvatar user={user} size={size} />
      {avatarOnly ? null : (
        <span className="truncate text-sm">{name}</span>
      )}
    </Link>
  );

  if (!hoverCard) return trigger;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="w-72 p-0"
      >
        {hoverCard}
      </PopoverContent>
    </Popover>
  );
}
