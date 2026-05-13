import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { tagColorClasses } from "./helpers";

interface TagChipProps {
  name: string;
  /** Palette name (slate/navy/blue/…) or `#RRGGBB` hex. */
  color?: string;
  size?: "sm" | "md";
  /** When provided, an × button appears with its own 44px-min touch target. */
  onRemove?: () => void;
  /** When provided, the chip body becomes interactive (role=button). */
  onClick?: () => void;
  /** When provided, customizes the accessible label for the chip body. */
  bodyAriaLabel?: string;
  className?: string;
}

/**
 * Coloured pill for a tag. Renders one of three modes:
 *  - Informational: no callbacks.
 *  - Removable: × button calls `onRemove()` (does not bubble).
 *  - Interactive: chip body calls `onClick()` (Enter/Space activate).
 * Both `onClick` and `onRemove` may be set; the × always wins its hit area.
 *
 * Color values accept either a palette name (mapped to `bg-tag-<name>`
 * + `text-tag-<name>-foreground` tokens) OR a raw `#RRGGBB` hex string
 * (rendered via inline style with YIQ-based contrast text). Anything
 * else falls back to slate.
 */
export function TagChip({
  name,
  color = "slate",
  size = "sm",
  onRemove,
  onClick,
  bodyAriaLabel,
  className,
}: TagChipProps) {
  const { classes, inlineStyle } = tagColorClasses(color);
  const interactive = typeof onClick === "function";
  const sizeClasses =
    size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";

  const handleBodyKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!interactive) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <span
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? bodyAriaLabel ?? `Edit tag ${name}` : undefined}
      onClick={
        interactive
          ? (e) => {
              // Don't trigger when the × button was the actual target.
              if ((e.target as HTMLElement).closest("[data-tag-remove]")) return;
              onClick?.();
            }
          : undefined
      }
      onKeyDown={interactive ? handleBodyKeyDown : undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium",
        sizeClasses,
        classes,
        interactive &&
          "cursor-pointer hover:ring-1 hover:ring-foreground/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      style={inlineStyle ?? undefined}
    >
      {name}
      {onRemove ? (
        <button
          type="button"
          data-tag-remove
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${name}`}
          // Visible target is 16px × 16px (the icon + hover ring).
          // A ::before pseudo-element expands the actual hit area to
          // ~44px × 44px so finger-tap targets meet WCAG 2.5.5 Target
          // Size without affecting the chip's visual size or layout.
          className="-mr-0.5 ml-0.5 relative inline-flex h-4 w-4 items-center justify-center rounded-full p-0.5 hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring before:absolute before:inset-[-14px] before:content-['']"
        >
          <X size={10} aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
