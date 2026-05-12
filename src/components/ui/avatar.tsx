import { cn } from "@/lib/utils";

interface AvatarProps {
  src?: string | null;
  /** Used to derive initials and the deterministic fallback color. */
  name: string;
  /** Used as the seed for the deterministic color hash. */
  id: string;
  size?: number;
  className?: string;
}

/**
 * Avatar — primitive. Renders a Microsoft Graph profile photo
 * (cached via Vercel Blob → users.photo_blob_url) when available, else
 * a colored circle with the user's initials. Color is derived from the
 * user's id with a tiny string hash so the same user always gets the
 * same color across sessions and devices.
 */
export function Avatar({ src, name, id, size = 36, className }: AvatarProps) {
  const initials = getInitials(name);
  const palette = AVATAR_PALETTE[hashString(id) % AVATAR_PALETTE.length];

  if (src) {
    // The Blob store is private; route image bytes through the
    // authenticated proxy at /api/users/[id]/avatar instead of using
    // the raw blob URL. `src` (the DB photo_blob_url value) acts as a
    // "this user has a photo" flag here.
    const proxySrc = `/api/users/${encodeURIComponent(id)}/avatar`;
    return (
      <span
        className={cn(
          "inline-block shrink-0 overflow-hidden rounded-full ring-1 ring-glass-border",
          className,
        )}
        style={{ width: size, height: size }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={proxySrc}
          alt={name}
          width={size}
          height={size}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ring-1 ring-glass-border",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: palette.bg,
        color: palette.fg,
        fontSize: Math.max(11, Math.round(size * 0.36)),
      }}
      aria-label={name}
    >
      {initials}
    </span>
  );
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Tiny deterministic hash. Not cryptographic — only used to pick a color
 * bucket. djb2 produces a stable 32-bit-ish output across runtimes.
 */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return Math.abs(h);
}

const AVATAR_PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: "oklch(0.50 0.15 250)", fg: "oklch(0.96 0.01 250)" }, // navy
  { bg: "oklch(0.55 0.15 200)", fg: "oklch(0.96 0.01 200)" }, // teal
  { bg: "oklch(0.55 0.15 145)", fg: "oklch(0.96 0.01 145)" }, // green
  { bg: "oklch(0.55 0.15 80)", fg: "oklch(0.96 0.01 80)" },  // amber
  { bg: "oklch(0.55 0.18 27)", fg: "oklch(0.97 0.01 27)" },   // rose
  { bg: "oklch(0.50 0.18 290)", fg: "oklch(0.97 0.01 290)" }, // violet
  { bg: "oklch(0.55 0.15 170)", fg: "oklch(0.96 0.01 170)" }, // mint
  { bg: "oklch(0.55 0.18 40)", fg: "oklch(0.97 0.01 40)" },   // orange
];
