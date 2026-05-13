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
  const removable = typeof onRemove === "function";
  const sizeClasses =
    size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs";

  const sharedShellClasses = cn(
    "inline-flex items-center gap-1 rounded-full font-medium",
    sizeClasses,
    classes,
    className,
  );

  // Non-interactive read-only chip — plain span.
  if (!interactive && !removable) {
    return (
      <span className={sharedShellClasses} style={inlineStyle ?? undefined}>
        {name}
      </span>
    );
  }

  // Removable-only chip (legacy TagInput in form-hidden mode) — span
  // shell with a single nested × button. Span isn't interactive
  // (no role/tabIndex) so the nested button is the only widget.
  if (!interactive && removable) {
    return (
      <span className={sharedShellClasses} style={inlineStyle ?? undefined}>
        {name}
        <RemoveButton name={name} onRemove={onRemove!} />
      </span>
    );
  }

  // Interactive-only chip — body is a real <button>, no × child.
  if (interactive && !removable) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={bodyAriaLabel ?? `Edit tag ${name}`}
        className={cn(
          sharedShellClasses,
          "cursor-pointer hover:ring-1 hover:ring-foreground/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        style={inlineStyle ?? undefined}
      >
        {name}
      </button>
    );
  }

  // Both interactive AND removable — render as a flex shell that
  // contains TWO sibling buttons (body + remove). Nesting one button
  // inside another (or inside role="button") is a WAI-ARIA violation
  // and breaks keyboard tab order. Sibling buttons are both reachable
  // and both fire independently.
  return (
    <span
      className={cn(sharedShellClasses, "p-0")}
      style={inlineStyle ?? undefined}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={bodyAriaLabel ?? `Edit tag ${name}`}
        className={cn(
          "inline-flex items-center rounded-full bg-transparent text-inherit cursor-pointer hover:ring-1 hover:ring-foreground/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          sizeClasses,
        )}
      >
        {name}
      </button>
      <RemoveButton name={name} onRemove={onRemove!} />
    </span>
  );
}

function RemoveButton({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}) {
  return (
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
  );
}
