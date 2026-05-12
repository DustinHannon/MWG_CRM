import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type UserAvatarSize = "xs" | "sm" | "md" | "lg";

const SIZE_PX: Record<UserAvatarSize, number> = {
  xs: 20,
  sm: 28,
  md: 40,
  lg: 80,
};

export interface UserAvatarUserShape {
  id: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
}

interface UserAvatarProps {
  user: UserAvatarUserShape;
  size?: UserAvatarSize;
  className?: string;
}

/**
 * canonical user avatar. Wraps the existing `<Avatar>` primitive
 * (which already handles the `/api/users/[id]/avatar` proxy URL when
 * `src` is non-null and the deterministic-color initials fallback when
 * `src` is null).
 *
 * Use semantic sizes:
 * xs (20px): Kanban card chips, dense pills
 * sm (28px): table rows, default chip
 * md (40px): hover-card header, "Owned by" feature card
 * lg (80px): /users/[id] profile header
 */
export function UserAvatar({
  user,
  size = "sm",
  className,
}: UserAvatarProps) {
  const px = SIZE_PX[size];
  const name = resolveName(user);
  return (
    <Avatar
      src={user.photoUrl ?? null}
      name={name}
      id={user.id}
      size={px}
      className={cn(className)}
    />
  );
}

export function resolveName(user: UserAvatarUserShape): string {
  if (user.displayName && user.displayName.trim()) return user.displayName;
  const parts = [user.firstName, user.lastName]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (parts.length > 0) return parts.join(" ");
  return "(Unnamed user)";
}
